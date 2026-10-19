import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The plugin imports @deepseek-ai/dsh-tools, which only the installed runtime
// provides. Materialize a stub beside a copy of the plugin so `apply` runs for
// real without depending on the desktop app layout.
const source = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "skill-author-section-"));
const plugin = join(root, "node_modules", "dsh-skill-author");
const toolsDir = join(root, "node_modules", "@deepseek-ai", "dsh-tools");

function stubRuntime() {
  mkdirSync(plugin, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  copyFileSync(join(source, "index.js"), join(plugin, "index.js"));
  copyFileSync(join(source, "package.json"), join(plugin, "package.json"));
  writeFileSync(join(toolsDir, "package.json"), JSON.stringify({
    name: "@deepseek-ai/dsh-tools",
    version: "0.0.0",
    type: "module",
    exports: "./index.js"
  }));
  writeFileSync(join(toolsDir, "index.js"), "export const defineTool = spec => spec;\n");
}

try {
  stubRuntime();
  const { apply } = await import(pathToFileURL(join(plugin, "index.js")).href);

  // 1. A profile with systemPrompt: one section, fixed name/order, actionable text.
  let section;
  let tool;
  apply({
    get: (name) => name === "systemPrompt" ? { section: (entry) => { section = entry; } } : undefined,
    tools: { register: (definition) => { tool = definition; return () => {}; } },
    logger: { warn() {} }
  });
  assert.ok(section, "retention section must be registered");
  assert.equal(section.name, "skill-author:retention", "section name must be stable for scoped overrides");
  assert.ok(Number.isFinite(section.order), "order must be finite");
  assert.ok(section.order > 1000 && section.order < 10000, "order must sit after tool sections and before harness paths");
  assert.equal(typeof section.text, "string");
  assert.match(section.text, /skill_manage/, "the instruction must name the tool");
  assert.match(section.text, /scope/, "the instruction must cover scope choice");
  assert.match(section.text, /Report every skill/, "the instruction must require reporting");
  assert.equal(tool?.name, "skill_manage", "tool registration still happens");

  // 2. A profile without the prompt service: the tool must still be registered.
  let toolsOnly;
  apply({
    get: () => undefined,
    tools: { register: (definition) => { toolsOnly = definition; return () => {}; } },
    logger: { warn() {} }
  });
  assert.equal(toolsOnly?.name, "skill_manage", "missing systemPrompt must not disable the tool");

  // 3. A duplicate registration (double load / hot reload) warns instead of failing.
  let warned = "";
  let survived;
  apply({
    get: () => ({ section: () => { throw new Error("prompt section \"skill-author:retention\" is already registered"); } }),
    tools: { register: (definition) => { survived = definition; return () => {}; } },
    logger: { warn: (message) => { warned = message; } }
  });
  assert.equal(survived?.name, "skill_manage", "a duplicate section must not remove the tool");
  assert.match(warned, /retention section unavailable/);

  console.log("PASS: retention section registered, order bounded, missing service degrades, duplicate registration warns");
} finally {
  rmSync(root, { recursive: true, force: true });
}
