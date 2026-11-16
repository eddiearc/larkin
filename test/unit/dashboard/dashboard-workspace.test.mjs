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

test("dashboard workspace edits replace text files only when the loaded version is still current", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-workspace-edit-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-outside-"));
  try {
    const { collectWorkspaceEntry, writeWorkspaceFile } = await import(MODULE);
    const agentId = "cli_dashboard2";
    const workspace = path.join(temp, "agents", agentId);
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "old rules\n", { mode: 0o640 });
    fs.writeFileSync(path.join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "escape.txt"));
    const config = { larkinHome: temp, agents: { [agentId]: { agentId } } };

    const loaded = collectWorkspaceEntry(config, agentId, "AGENTS.md");
    assert.match(loaded.sha256, /^[0-9a-f]{64}$/);
    assert.equal(collectWorkspaceEntry(config, agentId, "image.png").sha256, null);
    assert.equal(collectWorkspaceEntry(config, agentId, "AGENTS.md", 3).sha256, null);

    const saved = writeWorkspaceFile(config, agentId, "AGENTS.md", "new rules\n", loaded.sha256);
    assert.equal(saved.content, "new rules\n");
    assert.notEqual(saved.sha256, loaded.sha256);
    assert.equal(fs.statSync(path.join(workspace, "AGENTS.md")).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(workspace).filter((name) => name.endsWith(".tmp")), []);

    // A stale editor must not overwrite a concurrent Agent edit.
    assert.throws(() => writeWorkspaceFile(config, agentId, "AGENTS.md", "stale\n", loaded.sha256), (error) => error.statusCode === 409);
    assert.equal(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), "new rules\n");

    // An Agent edit that lands while the new content is being written is not overwritten either.
    assert.throws(() => writeWorkspaceFile(config, agentId, "AGENTS.md", "dashboard\n", saved.sha256, undefined, () => {
      fs.writeFileSync(path.join(workspace, "AGENTS.md"), "agent edit\n");
    }), (error) => error.statusCode === 409);
    assert.equal(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), "agent edit\n");
    assert.deepEqual(fs.readdirSync(workspace).filter((name) => name.endsWith(".tmp")), []);
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "new rules\n");

    const image = collectWorkspaceEntry(config, agentId, "image.png");
    assert.throws(() => writeWorkspaceFile(config, agentId, "image.png", "x", "0".repeat(64)), (error) => error.statusCode === 415);
    assert.equal(image.binary, true);
    assert.throws(() => writeWorkspaceFile(config, agentId, "escape.txt", "x", "0".repeat(64)), (error) => error.statusCode === 403);
    assert.throws(() => writeWorkspaceFile(config, agentId, "../outside", "x", "0".repeat(64)), (error) => error.statusCode === 400);
    assert.throws(() => writeWorkspaceFile(config, agentId, "missing.md", "x", "0".repeat(64)), (error) => error.statusCode === 404);
    assert.throws(() => writeWorkspaceFile(config, agentId, "AGENTS.md", "x", "not-a-hash"), (error) => error.statusCode === 400);
    assert.throws(() => writeWorkspaceFile(config, agentId, "AGENTS.md", "a\u0000b", saved.sha256), (error) => error.statusCode === 400);
    assert.throws(() => writeWorkspaceFile(config, agentId, "AGENTS.md", "too long", saved.sha256, 4), (error) => error.statusCode === 413);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("dashboard rule files report AGENTS.md / CLAUDE.md and only create missing ones", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-rules-"));
  try {
    const { collectInstructionFiles, createInstructionFile } = await import(MODULE);
    const agentId = "cli_dashboard3";
    const workspace = path.join(temp, "agents", agentId);
    fs.mkdirSync(workspace, { recursive: true });
    const config = { larkinHome: temp, agents: { [agentId]: { agentId } } };

    assert.deepEqual(collectInstructionFiles(config, agentId).files.map(({ name, file, linkedTo, error }) => ({ name, file, linkedTo, error })), [
      { name: "AGENTS.md", file: null, linkedTo: null, error: null },
      { name: "CLAUDE.md", file: null, linkedTo: null, error: null },
    ]);

    const created = createInstructionFile(config, agentId, "AGENTS.md", "# 角色\n");
    assert.equal(created.content, "# 角色\n");
    assert.equal(fs.statSync(path.join(workspace, "AGENTS.md")).mode & 0o777, 0o644);
    // Never overwrites: a second create (e.g. from a stale page) is a conflict.
    assert.throws(() => createInstructionFile(config, agentId, "AGENTS.md", "other"), (error) => error.statusCode === 409);
    assert.equal(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8"), "# 角色\n");

    fs.symlinkSync("AGENTS.md", path.join(workspace, "CLAUDE.md"));
    const [agents, claude] = collectInstructionFiles(config, agentId).files;
    assert.equal(agents.file.content, "# 角色\n");
    assert.equal(claude.linkedTo, "AGENTS.md");
    assert.throws(() => createInstructionFile(config, agentId, "CLAUDE.md", "@AGENTS.md\n"), (error) => error.statusCode === 409);

    assert.throws(() => createInstructionFile(config, agentId, "notes.md", "x"), (error) => error.statusCode === 400);
    assert.throws(() => createInstructionFile(config, agentId, "../AGENTS.md", "x"), (error) => error.statusCode === 400);
    assert.throws(() => createInstructionFile(config, agentId, "AGENTS.md", 42), (error) => error.statusCode === 400);
    fs.rmSync(path.join(workspace, "CLAUDE.md"));
    assert.throws(() => createInstructionFile(config, agentId, "CLAUDE.md", "a\u0000b"), (error) => error.statusCode === 400);
    assert.throws(() => createInstructionFile(config, agentId, "CLAUDE.md", "too long", 4), (error) => error.statusCode === 413);
    assert.equal(fs.existsSync(path.join(workspace, "CLAUDE.md")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
