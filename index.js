import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 500;
const MAX_CONTENT = 100_000;

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
      "Actions: create (fails if the skill exists), patch (replaces the whole SKILL.md; pass content), delete."
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
        description: "Required for create. One sentence, at most 500 characters, stating the capability and when to use it."
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
      const file = join(dir, "SKILL.md");
      assertInside(root, dir);

      if (action === "delete") {
        const existing = await readFile(file, "utf8").catch((error) => {
          if (error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (existing === undefined) throw new Error(`skill "${skillName}" does not exist at ${file}`);
        const retiredRoot = join(dirname(root), ".deleted-skills");
        await mkdir(retiredRoot, { recursive: true });
        const retired = join(retiredRoot, `${skillName}-${Date.now()}`);
        await rename(dir, retired);
        return {
          ok: true,
          action,
          scope,
          name: skillName,
          path: file,
          archivedTo: retired,
          note: "Removed from the skill root. The filesystem provider will drop it from the catalog on the next step. A copy was renamed beside the root instead of being destroyed."
        };
      }

      const body = String(args.content ?? "").replace(/^\uFEFF/, "").trim();
      if (!body) throw new Error("content is required for create and patch");
      if (body.length > MAX_CONTENT) throw new Error(`content is ${body.length} characters; limit is ${MAX_CONTENT}`);
      if (/^---\s*\n/.test(body)) {
        throw new Error("content must be the markdown body only; the tool writes the YAML frontmatter");
      }

      const existing = await readFile(file, "utf8").catch((error) => {
        if (error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (action === "create" && existing !== undefined) {
        throw new Error(`skill "${skillName}" already exists at ${file}; use action "patch" to replace it`);
      }
      if (action === "patch" && existing === undefined) {
        throw new Error(`skill "${skillName}" does not exist at ${file}; use action "create"`);
      }

      let description = String(args.description ?? "").trim();
      if (!description && action === "patch" && existing) {
        description = frontmatterValue(existing, "description");
      }
      if (!description) throw new Error("description is required");
      if (description.length > MAX_DESCRIPTION) {
        throw new Error(`description is ${description.length} characters; limit is ${MAX_DESCRIPTION}`);
      }
      if (/[\r\n]/.test(description) || description.includes(":")) {
        throw new Error("description must be a single line and must not contain ':'");
      }

      const document = renderDocument(skillName, description, body);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.SKILL.md.${process.pid}.tmp`);
      await writeFile(tmp, document, "utf8");
      await rename(tmp, file);
      return {
        ok: true,
        action,
        scope,
        name: skillName,
        path: file,
        bytes: Buffer.byteLength(document),
        note: "Saved. The filesystem skill provider watches this root, so the catalog updates on the next step. This session may already have loaded the previous catalog; a new session is guaranteed to see it."
      };
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

  ctx.tools.register(tool);
  return () => ctx.tools.unregister?.(tool);
}

async function resolveRoot(scope, cwd) {
  if (scope === "user") {
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    return join(resolve(home), "skills");
  }
  if (!cwd) throw new Error("project scope requires a session workspace");
  const projectRoot = await findProjectRoot(resolve(cwd));
  return join(projectRoot, ".dsh", "skills");
}

async function findProjectRoot(start) {
  let current = resolve(start);
  const stop = resolve(parseDrive(current));
  while (true) {
    try {
      const git = await readFile(join(current, ".git"));
      if (git !== undefined) return current;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
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

function assertInside(root, target) {
  const prefix = resolve(root).replace(/[\\/]+$/, "") + sep;
  const full = resolve(target);
  if (!full.startsWith(prefix)) throw new Error(`refusing to write outside ${root}`);
}

function frontmatterValue(document, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(document);
  if (!match) return "";
  const line = match[1].split(/\r?\n/).find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, "") : "";
}

function renderDocument(skillName, description, body) {
  return [
    "---",
    `name: ${skillName}`,
    `description: ${JSON.stringify(description)}`,
    "metadata:",
    "  hermes:",
    "    created_by: agent",
    "---",
    "",
    body.endsWith("\n") ? body : `${body}\n`
  ].join("\n");
}
