import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-workspace.mjs")).href;

test("dashboard workspace projection stays inside the canonical Agent root", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-workspace-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-outside-"));
  try {
    const { collectWorkspaceEntry, safeWorkspacePath } = await import(MODULE);
    const agentId = "cli_dashboard1";
    const workspace = path.join(temp, "agents", agentId);
    fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "notes", "hello.md"), "hello");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
    const config = { larkinHome: temp, agents: { [agentId]: { agentId } } };

    const directory = collectWorkspaceEntry(config, agentId, "");
    assert.equal(directory.kind, "directory");
    assert.deepEqual(directory.entries.map((entry) => entry.name), ["notes"]);
    const file = collectWorkspaceEntry(config, agentId, "notes/hello.md", 3);
    assert.deepEqual({ kind: file.kind, content: file.content, truncated: file.truncated }, {
      kind: "file", content: "hel", truncated: true,
    });
    assert.throws(() => safeWorkspacePath(config, agentId, "../outside"), (error) => error.statusCode === 400);
    assert.throws(() => safeWorkspacePath(config, agentId, "escape.txt"), (error) => error.statusCode === 403);

    fs.rmSync(path.join(temp, "agents"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(temp, "agents"), "dir");
    assert.throws(() => collectWorkspaceEntry(config, agentId, ""), (error) => error.statusCode === 403);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("production dashboard delegates workspace reads to the TypeScript authority", () => {
  const built = fs.readFileSync(path.join(ROOT, "dist/app/dashboard.mjs"), "utf8");
  assert.match(built, /dashboard-view-model\.mjs/);
  assert.doesNotMatch(built, /packages\/larkin-shell|fork\/feishu/);
  const server = fs.readFileSync(path.join(ROOT, "src/app/dashboard.ts"), "utf8");
  assert.match(server, /from ["']\.\.\/dashboard\/dashboard-view-model\.js["']/);
  assert.doesNotMatch(server, /function safeWorkspacePath|collectTypedWorkspaceEntry/);
  const viewModel = fs.readFileSync(path.join(ROOT, "src/dashboard/dashboard-view-model.ts"), "utf8");
  assert.match(viewModel, /from ["']\.\/dashboard-workspace\.js["']/);
  assert.match(viewModel, /collectTypedWorkspaceEntry\(config, agentId \|\| "", requestedPath\)/);
  assert.doesNotMatch(viewModel, /function safeWorkspacePath/);
});
