import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 500;
const MAX_CONTENT = 100_000;
/** Frontmatter keys this tool owns; every other key is preserved verbatim. */
const MANAGED_KEYS = new Set(["name", "description", "metadata"]);
/** Invocation keys the DSH skill provider rejects; such a file is already unreadable. */
const LEGACY_INVOCATION_KEYS = new Set(["disableModelInvocation", "modelInvocable", "userInvocable"]);
/** Errors that mean "this filesystem cannot hard-link", not "the target exists". */
const LINK_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOSYS", "EOPNOTSUPP", "ENOTSUP", "EXDEV", "EMLINK"]);

/**
 * Serializes one skill's check-to-publish window inside this host process. DSH's
 * exclusive execution mode only orders calls inside a single assistant step, so
 * two sessions of this host can otherwise interleave on the same file.
 */
const queues = new Map();

export const name = "skill-author";
export const inject = ["tools"];

/**
 * Save, replace, or delete a skill under the same roots the filesystem
 * provider scans: `<project>/.dsh/skills` and `$DSH_HOME/skills`.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  const tool = defineTool({
    name: "skill_manage",
    description: [
      "Save a reusable procedure as a Harness skill so later sessions can load it.",
      "Choose scope yourself: \"user\" for a workflow useful in every workspace (~/.dsh/skills),",
      "\"project\" for a workflow tied to the current repository (<project>/.dsh/skills).",
      "Write only after a non-trivial procedure actually worked, or when the user asks to remember one.",
      "Do not save one-off tasks, secrets, or a duplicate of a skill already in the catalog.",
      "Frontmatter keys this tool does not own (for example disable-model-invocation, user-invocable, whenToUse) are preserved verbatim when patching.",
      "Actions: create (fails if the skill exists), patch (replaces the SKILL.md body; pass content), delete."
    ].join(" "),
    parameters: {
      action: {
        type: "string",
        enum: ["create", "patch", "delete"],
        required: true,
        description: "create a new skill, patch (replace) an existing SKILL.md, or delete the skill directory."
      },
      name: {
        type: "string",
        required: true,
        description: "Kebab-case skill name, 1-64 chars. Must match the frontmatter name."
      },
      scope: {
        type: "string",
        enum: ["user", "project"],
        required: true,
        description: "user = useful across workspaces; project = useful only in the current repo."
      },
      description: {
        type: "string",
        description: "Required for create. One sentence, at most 500 characters, stating the capability and when to use it. Omit on patch to keep the existing description."
      },
      content: {
        type: "string",
        description: "Full SKILL.md body after the frontmatter, required for create and patch. Include When to Use, Procedure, and Pitfalls."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          action: { type: "string", required: true },
          scope: { type: "string", required: true },
          name: { type: "string", required: true },
          path: { type: "string", required: true },
          bytes: { type: "number" },
          preservedFrontmatterKeys: { type: "array", items: { type: "string" } },
          archivedTo: { type: "string" },
          note: { type: "string", required: true }
        }
      },
      render(_args, value) {
        const lines = [
          `${value.action} ${value.scope} skill ${value.name}: ${value.path}`
        ];
        if (value.archivedTo) lines.push(`archived to ${value.archivedTo}`);
        if (value.bytes !== undefined) lines.push(`${value.bytes} bytes`);
        if (value.preservedFrontmatterKeys?.length) lines.push(`preserved frontmatter: ${value.preservedFrontmatterKeys.join(", ")}`);
        lines.push(value.note);
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const skillName = String(args.name ?? "").trim();
      if (!NAME_RE.test(skillName) || skillName.length > MAX_NAME) {
        throw new Error(`invalid skill name "${skillName}": use lowercase kebab-case, at most ${MAX_NAME} characters`);
      }
      const scope = args.scope;
      if (scope !== "user" && scope !== "project") {
        throw new Error(`invalid scope "${scope}": expected "user" or "project"`);
      }
      const action = args.action;
      if (action !== "create" && action !== "patch" && action !== "delete") {
        throw new Error(`invalid action "${action}"`);
      }

      const root = await resolveRoot(scope, exec.agent?.session.header.cwd);
      const dir = join(root, skillName);
      assertLexicallyInside(root, dir);
      const file = join(dir, "SKILL.md");

      return withQueue(`${root}${sep}${skillName}`, async () => {
        await mkdir(root, { recursive: true });
        const canonicalRoot = await realpath(root);
        if (action === "delete") return retireSkill({ root, canonicalRoot, dir, file, skillName, scope });
        return saveSkill({ canonicalRoot, dir, file, skillName, scope, action, args });
      });
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `${args.action ?? "save"} skill ${args.name ?? ""}`.trim(),
        kind: "write",
        rawInput: `${args.scope ?? ""}:${args.name ?? ""}`
      };
    }
  });

  return ctx.tools.register(tool);
}

/** Create or replace one skill file without ever clobbering a concurrent writer. */
async function saveSkill(options) {
  const { canonicalRoot, dir, file, skillName, scope, action, args } = options;
  await mkdir(dir, { recursive: true });
  await assertRealDirectory(canonicalRoot, dir, "skill directory");

  const existing = await readText(file);
  if (action === "create" && existing !== undefined) {
    throw new Error(`skill "${skillName}" already exists at ${file}; use action "patch" to replace it`);
  }
  if (action === "patch" && existing === undefined) {
    throw new Error(`skill "${skillName}" does not exist at ${file}; use action "create"`);
  }

  const body = String(args.content ?? "").replace(/^\uFEFF/, "").trim();
  if (!body) throw new Error("content is required for create and patch");
  if (body.length > MAX_CONTENT) throw new Error(`content is ${body.length} characters; limit is ${MAX_CONTENT}`);
  if (/^---\s*\n/.test(body)) {
    throw new Error("content must be the markdown body only; the tool writes the YAML frontmatter");
  }

  const requested = String(args.description ?? "").trim();
  if (/[\r\n]/.test(requested)) throw new Error("description must be a single line");
  if (requested.length > MAX_DESCRIPTION) {
    throw new Error(`description is ${requested.length} characters; limit is ${MAX_DESCRIPTION}`);
  }
  // Omitted on patch: carry the existing description line over untouched instead
  // of re-serializing it, so quoting and escapes cannot drift.
  const existingDescription = existing === undefined ? undefined : findEntry(existing, "description");
  if (!requested && existingDescription === undefined) throw new Error("description is required");
  const descriptionLines = requested
    ? [`description: ${JSON.stringify(requested)}`]
    : existingDescription.lines;

  const preserved = preservedFrontmatterKeys(existing);
  const document = renderDocument(existing, skillName, descriptionLines, body);
  const tmp = join(dir, `.SKILL.md.${randomUUID()}.tmp`);
  await writeFile(tmp, document, { encoding: "utf8", flag: "wx" });
  try {
    if (action === "create") await publishNewFile(tmp, file, skillName);
    else await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    action,
    scope,
    name: skillName,
    path: file,
    bytes: Buffer.byteLength(document),
    preservedFrontmatterKeys: preserved,
    note: "Saved. The filesystem skill provider watches this root, so the catalog updates on the next step. This session may already have loaded the previous catalog; a new session is guaranteed to see it."
  };
}

/** Publish a brand-new skill atomically; a losing concurrent create keeps its file. */
async function publishNewFile(tmp, file, skillName) {
  try {
    await link(tmp, file);
  } catch (error) {
    const code = error?.code;
    if (code === "EEXIST") {
      throw new Error(`skill "${skillName}" already exists at ${file}; use action "patch" to replace it`);
    }
    if (!LINK_UNSUPPORTED.has(code)) throw error;
    if (await pathExists(file)) {
      throw new Error(`skill "${skillName}" already exists at ${file}; use action "patch" to replace it`);
    }
    await rename(tmp, file);
    return;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Move one skill directory beside its root instead of destroying it. */
async function retireSkill(options) {
  const { root, canonicalRoot, dir, file, skillName, scope } = options;
  if (!(await pathExists(file))) throw new Error(`skill "${skillName}" does not exist at ${file}`);
  await assertRealDirectory(canonicalRoot, dir, "skill directory");
  const retiredRoot = join(dirname(root), ".deleted-skills");
  await mkdir(retiredRoot, { recursive: true });
  const retired = join(retiredRoot, `${skillName}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await rename(dir, retired);
  return {
    ok: true,
    action: "delete",
    scope,
    name: skillName,
    path: file,
    archivedTo: retired,
    note: "Removed from the skill root. The filesystem provider will drop it from the catalog on the next step. A copy was renamed beside the root instead of being destroyed."
  };
}

/** Resolve the user or project skill root exactly as the filesystem provider does. */
async function resolveRoot(scope, cwd) {
  if (scope === "user") return join(resolveHarnessHome(), "skills");
  if (!cwd) throw new Error("project scope requires a session workspace");
  const projectRoot = await findProjectRoot(resolve(cwd));
  return join(projectRoot, ".dsh", "skills");
}

/** `$DSH_HOME` when set (blank counts as unset, `~` is expanded), else `~/.dsh`. */
function resolveHarnessHome() {
  const configured = process.env.DSH_HOME;
  const value = typeof configured === "string" ? configured.trim() : "";
  if (!value) return join(homedir(), ".dsh");
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

async function findProjectRoot(start) {
  let current = resolve(start);
  const stop = resolve(parseDrive(current));
  while (true) {
    if (await pathExists(join(current, ".git"))) return current;
    if (current === stop) return resolve(start);
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

function parseDrive(p) {
  const match = /^[A-Za-z]:/.exec(p);
  return match ? match[0] + sep : sep;
}

/** Lexical containment; the realpath check below is the authoritative one. */
function assertLexicallyInside(root, target) {
  const prefix = resolve(root).replace(/[\\/]+$/, "") + sep;
  const full = resolve(target);
  if (!full.startsWith(prefix)) throw new Error(`refusing to write outside ${root}`);
}

/**
 * Refuse a skill directory whose real path leaves the skill root, which is what
 * a symlinked skill directory would otherwise smuggle past the lexical check.
 */
async function assertRealDirectory(canonicalRoot, target, label) {
  const real = await realpath(target);
  const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (!real.startsWith(prefix)) throw new Error(`refusing to write outside the skill root: ${label} resolves to ${real}`);
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
}

/** Read a file, treating only "absent" as absent. */
async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/** Serialize one skill's mutations; the queue tail never retains a rejection. */
function withQueue(key, run) {
  const tail = queues.get(key) ?? Promise.resolve();
  const result = tail.then(run, run);
  const settled = result.then(() => {}, () => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return result;
}

/**
 * Split an existing frontmatter block into top-level `key:` entries, keeping each
 * entry's continuation lines so preserved keys survive byte for byte.
 */
function frontmatterEntries(document) {
  if (document === undefined) return [];
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(document);
  if (!match) {
    throw new Error("existing SKILL.md has no YAML frontmatter to preserve; fix it manually before patching");
  }
  const entries = [];
  for (const line of match[1].split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_-]+):/.exec(line);
    if (key) {
      entries.push({ key: key[1], lines: [line] });
      continue;
    }
    if (entries.length === 0) {
      if (line.trim() === "") continue;
      throw new Error(`existing SKILL.md frontmatter is not a plain key map: ${JSON.stringify(line)}`);
    }
    entries.at(-1).lines.push(line);
  }
  return entries;
}

/** Names of the frontmatter keys a patch will carry over untouched. */
function preservedFrontmatterKeys(document) {
  if (document === undefined) return [];
  return frontmatterEntries(document)
    .filter((entry) => !MANAGED_KEYS.has(entry.key))
    .map((entry) => entry.key);
}
function findEntry(document, key) {
  return frontmatterEntries(document).find((candidate) => candidate.key === key);
}

/** Rebuild the document: owned keys first, then every preserved key verbatim. */
function renderDocument(existing, skillName, descriptionLines, body) {
  const entries = frontmatterEntries(existing);
  const legacy = entries.find((entry) => LEGACY_INVOCATION_KEYS.has(entry.key));
  if (legacy !== undefined) {
    throw new Error(`existing SKILL.md uses unsupported frontmatter field "${legacy.key}"; DSH ignores such a file, so fix it manually before patching`);
  }
  const lines = [`name: ${skillName}`, ...descriptionLines];
  for (const entry of entries) {
    if (MANAGED_KEYS.has(entry.key)) continue;
    lines.push(...entry.lines);
  }
  lines.push(...metadataLines(entries.find((entry) => entry.key === "metadata")));
  const document = ["---", ...lines, "---", "", body.endsWith("\n") ? body : `${body}\n`].join("\n");
  if (!document.startsWith("---\n") || !document.includes(`\nname: ${skillName}\n`)) {
    throw new Error("refusing to write a malformed SKILL.md frontmatter block");
  }
  return document;
}

/** Keep foreign metadata sub-keys and make sure the hermes marker is present. */
function metadataLines(entry) {
  if (entry === undefined) return ["metadata:", "  hermes:", "    created_by: agent"];
  if (entry.lines[0].slice("metadata:".length).trim() !== "") return entry.lines;
  const children = entry.lines.slice(1);
  if (children.some((line) => /^\s+hermes\s*:/.test(line))) return ["metadata:", ...children];
  return ["metadata:", ...children, "  hermes:", "    created_by: agent"];
}
