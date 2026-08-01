import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUILT_SERVICE = path.join(ROOT, "dist/platform/workspace-service.mjs");
const START = "<!-- larkin:platform-rules:start -->";
const END = "<!-- larkin:platform-rules:end -->";
const LOCK_FILE = "workspace-reconcile.lock.json";
const LOCK_HOLDER_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const inspectFile = process.argv[1];
const lockDir = process.argv[2];
const releaseAfterMs = Number(process.argv[3]);
const { inspectProcess } = require(inspectFile);
const inspected = inspectProcess(process.pid);
if (!inspected.ok) throw new Error(inspected.reason || "process inspection failed");
fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
const file = path.join(lockDir, "workspace-reconcile.lock.json");
const record = {
  pid: process.pid,
  processStartToken: inspected.startToken,
  nonce: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
};
fs.writeFileSync(file, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write("READY\n");
if (releaseAfterMs >= 0) {
  setTimeout(() => { fs.rmSync(file, { force: true }); process.exit(0); }, releaseAfterMs);
} else {
  setInterval(() => {}, 25);
}
`;

async function loadService() {
  return import(pathToFileURL(BUILT_SERVICE).href);
}

function splitManaged(content) {
  const start = content.indexOf(START);
  const end = content.indexOf(END, start + START.length);
  assert.notEqual(start, -1, "managed block start marker must exist");
  assert.notEqual(end, -1, "managed block end marker must exist");
  return {
    before: content.slice(0, start),
    managed: content.slice(start, end + END.length),
    after: content.slice(end + END.length),
  };
}

function count(content, needle) {
  return content.split(needle).length - 1;
}

function lockDirFor(temp) {
  return path.join(temp, "state", "cli_phase1");
}

function symlinkUnavailable(error) {
  if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return false;
  process.stderr.write(`# symlink test skipped at runtime: ${error.code}\n`);
  return true;
}

async function startLockHolder(lockDir, releaseAfterMs) {
  const child = spawn(process.execPath, [
    "-e",
    LOCK_HOLDER_SCRIPT,
    path.join(ROOT, "dist/platform/process-inspect.cjs"),
    lockDir,
    String(releaseAfterMs),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = once(child, "exit");
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) resolve();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited before READY (${code}): ${stderr}`)));
  });
  return { child, exit };
}

function assertOwnerPlatformRules(managed) {
  assert.match(managed, /私聊消息[^\n]*(?:总是|全部|全都)[^\n]*唤醒/);
  assert.match(managed, /群聊[^\n]*真人未\s*@[^\n]*Agent×群[^\n]*Agent[^\n]*全局[^\n]*决定是否唤醒/);
  assert.match(managed, /机器人发的消息[\s\S]*只有[\s\S]*点名\s*@[^\n]*才会唤醒/);
  assert.match(managed, /@所有人[^\n]*不算/);
  assert.match(managed, /未[^\n]*@[^\n]*消息[^\n]*(?:入箱|频道历史)/);
  assert.match(managed, /不设[^\n]*(?:冷却|频率闸门)|无(?:冷却|频率闸门)/);
  assert.match(managed, /(?:非必要|除非确实需要)[^\n]*(?:不回|不要再)\s*@/);
  assert.match(managed, /commentary.*final_answer.*(?:不可见|不等于飞书出站)/);
  assert.match(managed, /只有[^\n]*成功调用[^\n]*larkin[^\n]*(?:发送|回复)[^\n]*(?:可见|反馈)/);
  assert.doesNotMatch(managed, /成功调用[^\n]*lark-cli[^\n]*(?:发送|回复)/);
  assert.match(managed, /多个外部步骤[^\n]*(?:首个|第一个)[^\n]*(?:外部|耗时)步骤前[^\n]*(?:简短确认|首响)/);
  assert.match(managed, /只回复[^\n]*(?:一次|单次)[^\n]*(?:不得|禁止)[^\n]*首响[^\n]*进度[^\n]*(?:goal|status)[^\n]*控制工具/);
  assert.match(managed, /只 poll 后保持沉默[^\n]*poll 后[^\n]*(?:立即停止|不得再调用)[^\n]*历史[^\n]*(?:goal|status)[^\n]*(?:控制|发现)工具[^\n]*(?:不发送|不得发送)[^\n]*(?:首响|进度|最终)/);
  assert.match(managed, /显式限制[^\n]*优先于[^\n]*默认首响[^\n]*进度[^\n]*没有[^\n]*显式限制[^\n]*普通[^\n]*(?:多步骤|长任务)[^\n]*仍[^\n]*首响/);
  assert.match(managed, /用户[^\n]*步骤顺序[^\n]*(?:严格|必须)[^\n]*顺序[^\n]*不得[^\n]*(?:fallback|重排|重复)/);
  assert.match(managed, /进度[^\n]*用户[^\n]*大阶段[^\n]*(?:而非|不按)[^\n]*(?:工具|小步骤)[^\n]*(?:仅在|只在)[^\n]*阶段变化[^\n]*明显延迟[^\n]*需要用户动作[^\n]*用户可感知阻塞[^\n]*同一阶段[^\n]*同一阻塞[^\n]*(?:不重复|只发送一次)/);
  assert.match(managed, /(?:^|\n)- 依赖前一步结果[^\n]*每次只调用一个[^\n]*禁止[^\n]*批量[^\n]*并行[^\n]*观察失败结果后[^\n]*只看下一动作[^\n]*继续同一方案[^\n]*retry[^\n]*禁止重复发送[^\n]*改用[^\n]*fallback[^\n]*其他方案[^\n]*必须先用 larkin[^\n]*阻塞[^\n]*下一步[^\n]*发送成功后[^\n]*才可调用新方案/);
  assert.match(managed, /(?:完成|无法继续|需要用户动作)[^\n]*larkin[^\n]*(?:最终结论|明确请求)/);
  assert.match(managed, /不得泄露[^\n]*thinking[^\n]*凭证[^\n]*原始工具输出[^\n]*内部路径/);
}

test("WorkspaceService preserves user bytes, upgrades one managed block in both prompt files, and is idempotent", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-workspace-"));
  const workspaceDir = path.join(temp, "workspace");
  const trustedWorkspaceRoot = temp;
  fs.mkdirSync(workspaceDir, { recursive: true });
  const agentsFile = path.join(workspaceDir, "AGENTS.md");
  const claudeFile = path.join(workspaceDir, "CLAUDE.md");
  const agentsBefore = `owner-prefix\n${START}\nstale managed rules\n${END}\nowner-suffix\n`;
  const claudeBefore = "claude-owner-content-without-final-newline";
  fs.writeFileSync(agentsFile, agentsBefore);
  fs.writeFileSync(claudeFile, claudeBefore);

  try {
    const { reconcileAgentWorkspace } = await loadService();
    await reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot, lockDir: lockDirFor(temp), agentId: "cli_phase1" });

    const agentsAfterFirst = fs.readFileSync(agentsFile, "utf8");
    const claudeAfterFirst = fs.readFileSync(claudeFile, "utf8");
    const agentsOriginalParts = splitManaged(agentsBefore);
    const agentsUpdatedParts = splitManaged(agentsAfterFirst);
    const claudeUpdatedParts = splitManaged(claudeAfterFirst);

    assert.equal(agentsUpdatedParts.before, agentsOriginalParts.before, "bytes before a managed block belong to the user");
    assert.equal(agentsUpdatedParts.after, agentsOriginalParts.after, "bytes after a managed block belong to the user");
    assert.doesNotMatch(agentsUpdatedParts.managed, /stale managed rules/);
    assert.equal(claudeUpdatedParts.before, claudeBefore, "an existing file without markers must remain an exact prefix");
    assert.equal(agentsUpdatedParts.managed, claudeUpdatedParts.managed, "AGENTS.md and CLAUDE.md must receive the identical managed block");
    for (const content of [agentsAfterFirst, claudeAfterFirst]) {
      assert.equal(count(content, START), 1);
      assert.equal(count(content, END), 1);
      assertOwnerPlatformRules(splitManaged(content).managed);
    }

    await reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    assert.equal(fs.readFileSync(agentsFile, "utf8"), agentsAfterFirst, "second reconciliation must be byte-stable");
    assert.equal(fs.readFileSync(claudeFile, "utf8"), claudeAfterFirst, "second reconciliation must be byte-stable");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService creates both prompt files for a new workspace", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-new-workspace-"));
  const workspaceDir = path.join(temp, "new-agent-workspace");
  try {
    const { reconcileAgentWorkspace } = await loadService();
    await reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const content = fs.readFileSync(path.join(workspaceDir, name), "utf8");
      assert.equal(count(content, START), 1);
      assert.equal(count(content, END), 1);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService preflights both files and never partially writes when either has malformed or duplicate markers", async () => {
  const { reconcileAgentWorkspace } = await loadService();
  const valid = `owner\n${START}\nold valid block\n${END}\ntail\n`;
  const corruptions = [
    `owner\n${START}\nunterminated managed block\n`,
    `owner\n${END}\nlone end marker\n`,
    `owner\n${END}\nreversed markers\n${START}\ntail\n`,
    `${valid}${START}\nduplicate block\n${END}\n`,
  ];
  for (const damagedName of ["AGENTS.md", "CLAUDE.md"]) {
    for (const damaged of corruptions) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-corrupt-workspace-"));
      const workspaceDir = path.join(temp, "workspace");
      fs.mkdirSync(workspaceDir, { recursive: true });
      const before = { "AGENTS.md": valid, "CLAUDE.md": valid, [damagedName]: damaged };
      for (const [name, content] of Object.entries(before)) fs.writeFileSync(path.join(workspaceDir, name), content);
      try {
        assert.throws(
          () => reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" }),
          /marker|managed|prompt|malformed|corrupt|duplicate/i,
        );
        for (const [name, content] of Object.entries(before)) {
          assert.equal(fs.readFileSync(path.join(workspaceDir, name), "utf8"), content, `${name} must not be partially rewritten`);
        }
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  }
});

test("WorkspaceService rejects a prompt symlink that escapes the workspace", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-symlink-workspace-"));
  const workspaceDir = path.join(temp, "workspace");
  const outsideFile = path.join(temp, "outside-owner-file.md");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(outsideFile, "outside owner bytes\n");
  fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), "claude owner bytes\n");
  try {
    try { fs.symlinkSync(outsideFile, path.join(workspaceDir, "AGENTS.md")); }
    catch (error) {
      if (symlinkUnavailable(error)) return;
      throw error;
    }
    const { reconcileAgentWorkspace } = await loadService();
    assert.throws(
      () => reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" }),
      /symlink|link|workspace|escape|unsafe/i,
    );
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside owner bytes\n");
    assert.equal(fs.readFileSync(path.join(workspaceDir, "CLAUDE.md"), "utf8"), "claude owner bytes\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService rejects a workspace directory symlink even when its target remains inside the trusted root", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-workspace-bridge-"));
  const trustedWorkspaceRoot = path.join(temp, "agents");
  const legacyWorkspace = path.join(trustedWorkspaceRoot, "legacy-app-id");
  const canonicalWorkspace = path.join(trustedWorkspaceRoot, "cli_phase1");
  fs.mkdirSync(legacyWorkspace, { recursive: true });
  fs.writeFileSync(path.join(legacyWorkspace, "AGENTS.md"), "legacy owner bytes\n");
  try {
    try { fs.symlinkSync(legacyWorkspace, canonicalWorkspace, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (symlinkUnavailable(error)) return;
      throw error;
    }
    const { reconcileAgentWorkspace } = await loadService();
    assert.throws(
      () => reconcileAgentWorkspace({
        workspaceDir: canonicalWorkspace,
        trustedWorkspaceRoot,
        lockDir: lockDirFor(temp),
        agentId: "cli_phase1",
      }),
      /symlink|symbolic link|workspace.*link|unsafe/i,
    );
    assert.equal(fs.realpathSync(canonicalWorkspace), fs.realpathSync(legacyWorkspace));
    assert.equal(fs.readFileSync(path.join(legacyWorkspace, "AGENTS.md"), "utf8"), "legacy owner bytes\n");
    assert.equal(fs.existsSync(path.join(legacyWorkspace, "CLAUDE.md")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService rejects a workspace directory symlink whose realpath escapes the trusted workspace root", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-workspace-escape-"));
  const trustedWorkspaceRoot = path.join(temp, "trusted-agents");
  const outsideWorkspace = path.join(temp, "outside-workspace");
  const canonicalWorkspace = path.join(trustedWorkspaceRoot, "cli_phase1");
  fs.mkdirSync(trustedWorkspaceRoot, { recursive: true });
  fs.mkdirSync(outsideWorkspace, { recursive: true });
  const outsideAgents = path.join(outsideWorkspace, "AGENTS.md");
  const outsideClaude = path.join(outsideWorkspace, "CLAUDE.md");
  fs.writeFileSync(outsideAgents, "outside agents owner bytes\n");
  fs.writeFileSync(outsideClaude, "outside claude owner bytes\n");
  try {
    try { fs.symlinkSync(outsideWorkspace, canonicalWorkspace, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (symlinkUnavailable(error)) return;
      throw error;
    }
    const { reconcileAgentWorkspace } = await loadService();
    assert.throws(
      () => reconcileAgentWorkspace({ workspaceDir: canonicalWorkspace, trustedWorkspaceRoot, lockDir: lockDirFor(temp), agentId: "cli_phase1" }),
      /symlink|link|workspace|escape|outside|unsafe|trusted/i,
    );
    assert.equal(fs.readFileSync(outsideAgents, "utf8"), "outside agents owner bytes\n");
    assert.equal(fs.readFileSync(outsideClaude, "utf8"), "outside claude owner bytes\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService preserves invalid UTF-8 owner bytes outside ASCII managed markers", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-binary-owner-"));
  const workspaceDir = path.join(temp, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const startBytes = Buffer.from(START, "ascii");
  const endBytes = Buffer.from(END, "ascii");
  const prefix = Buffer.from([0x6f, 0x77, 0x6e, 0x65, 0x72, 0x2d, 0x80, 0xff, 0x0a]);
  const suffix = Buffer.from([0x0a, 0xfe, 0x81, 0x2d, 0x74, 0x61, 0x69, 0x6c]);
  const agentsBefore = Buffer.concat([prefix, startBytes, Buffer.from("\nstale\n"), endBytes, suffix]);
  const claudeOwner = Buffer.from([0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x80, 0xff]);
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), agentsBefore);
  fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), claudeOwner);
  try {
    const { reconcileAgentWorkspace } = await loadService();
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    const agentsAfter = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"));
    const claudeAfter = fs.readFileSync(path.join(workspaceDir, "CLAUDE.md"));
    const managedStart = agentsAfter.indexOf(startBytes);
    const managedEnd = agentsAfter.indexOf(endBytes, managedStart) + endBytes.length;
    assert.deepEqual(agentsAfter.subarray(0, managedStart), prefix);
    assert.deepEqual(agentsAfter.subarray(managedEnd), suffix);
    assert.deepEqual(claudeAfter.subarray(0, claudeOwner.length), claudeOwner);
    const firstAgents = Buffer.from(agentsAfter);
    const firstClaude = Buffer.from(claudeAfter);
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, "AGENTS.md")), firstAgents);
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, "CLAUDE.md")), firstClaude);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService aborts when owner content changes after staging and preserves that owner edit", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-owner-race-"));
  const workspaceDir = path.join(temp, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const agentsFile = path.join(workspaceDir, "AGENTS.md");
  const claudeFile = path.join(workspaceDir, "CLAUDE.md");
  const agentsBefore = `owner\n${START}\nstale\n${END}\n`;
  const claudeBefore = "claude owner\n";
  fs.writeFileSync(agentsFile, agentsBefore);
  fs.writeFileSync(claudeFile, claudeBefore);
  const { reconcileAgentWorkspace } = await loadService();
  assert.throws(
    () => reconcileAgentWorkspace({
      workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1",
      testHooks: { afterStage(file) { if (path.basename(file) === "AGENTS.md") fs.appendFileSync(agentsFile, "owner-concurrent-edit\n"); } },
    }),
    /owner prompt.*changed concurrently|content changed concurrently/i,
  );
  try {
    assert.equal(fs.readFileSync(agentsFile, "utf8"), agentsBefore + "owner-concurrent-edit\n");
    assert.equal(fs.readFileSync(claudeFile, "utf8"), claudeBefore);
    assert.equal(fs.existsSync(path.join(workspaceDir, ".larkin-workspace-reconcile.lock")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService replays an owner edit made in the precise final-check to rename window", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-rename-window-"));
  const workspaceDir = path.join(temp, "workspace");
  const agentsFile = path.join(workspaceDir, "AGENTS.md");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(agentsFile, `owner-before\n${START}\nstale\n${END}\nowner-after\n`);
  fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), "claude-owner\n");
  let injected = false;
  const { reconcileAgentWorkspace } = await loadService();
  reconcileAgentWorkspace({
    workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1",
    testHooks: { beforeRename(source, destination) {
      if (!injected && path.basename(String(destination)) === "AGENTS.md" &&
          path.basename(String(source)).startsWith(".AGENTS.md.")) {
        injected = true;
        fs.appendFileSync(agentsFile, "owner-edit-in-rename-window\n");
      }
    } },
  });
  try {
    const content = fs.readFileSync(agentsFile, "utf8");
    assert.equal(injected, true);
    assert.match(content, /^owner-before\n/);
    assert.match(content, /owner-after\nowner-edit-in-rename-window\n$/);
    assert.equal(count(content, START), 1);
    assert.equal(count(content, END), 1);
    assert.doesNotMatch(content, /\nstale\n/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("WorkspaceService waits for a live state lock and reclaims SIGKILL/PID-reuse stale locks", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-state-lock-"));
  const workspaceDir = path.join(temp, "workspace");
  const lockDir = lockDirFor(temp);
  let liveHolder = null;
  let staleHolder = null;
  try {
    const { reconcileAgentWorkspace } = await loadService();
    liveHolder = await startLockHolder(lockDir, 150);
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir, agentId: "cli_phase1" });
    await liveHolder.exit;
    liveHolder = null;

    staleHolder = await startLockHolder(lockDir, -1);
    const metadata = JSON.parse(fs.readFileSync(path.join(lockDir, LOCK_FILE), "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), ["nonce", "pid", "processStartToken", "startedAt"]);
    staleHolder.child.kill("SIGKILL");
    await staleHolder.exit;
    staleHolder = null;
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir, agentId: "cli_phase1" });

    fs.writeFileSync(path.join(lockDir, LOCK_FILE), JSON.stringify({
      pid: process.pid,
      processStartToken: "reused-pid-with-different-start-token",
      nonce: "pid-reuse-fixture",
      startedAt: new Date().toISOString(),
    }) + "\n", { mode: 0o600 });
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir, agentId: "cli_phase1" });
    assert.equal(fs.existsSync(path.join(lockDir, LOCK_FILE)), false);
  } finally {
    liveHolder?.child.kill("SIGKILL");
    staleHolder?.child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("WorkspaceService keeps its lock in Agent state, ignores same-name user files, and preserves exact modes despite umask", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-mode-lock-"));
  const workspaceDir = path.join(temp, "workspace");
  const newWorkspaceDir = path.join(temp, "new-workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = path.join(workspaceDir, name);
    fs.writeFileSync(file, `owner\n${START}\nstale\n${END}\n`);
    fs.chmodSync(file, 0o666);
  }
  const oldUmask = process.umask(0o077);
  try {
    const { reconcileAgentWorkspace } = await loadService();
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    reconcileAgentWorkspace({ workspaceDir: newWorkspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      assert.equal(fs.statSync(path.join(workspaceDir, name)).mode & 0o777, 0o666);
      assert.equal(fs.statSync(path.join(newWorkspaceDir, name)).mode & 0o777, 0o600);
    }
    const userFile = path.join(workspaceDir, ".larkin-workspace-reconcile.lock");
    fs.writeFileSync(userFile, "owner file with an old lock-like name\n", { mode: 0o600 });
    const before = fs.readFileSync(path.join(workspaceDir, "AGENTS.md"));
    reconcileAgentWorkspace({ workspaceDir, trustedWorkspaceRoot: temp, lockDir: lockDirFor(temp), agentId: "cli_phase1" });
    assert.deepEqual(fs.readFileSync(path.join(workspaceDir, "AGENTS.md")), before);
    assert.equal(fs.readFileSync(userFile, "utf8"), "owner file with an old lock-like name\n");
    assert.equal(fs.existsSync(path.join(lockDirFor(temp), "workspace-reconcile.lock.json")), false);
  } finally {
    process.umask(oldUmask);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
