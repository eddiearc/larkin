import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { createLarkinTmux } from "../../src/runtime/pi-tmux.ts";
import { OWN_EXTENSION_NAME, OWN_TMUX_BASH_BUNDLE } from "./pi-tmux-bash-grader.mjs";

export { OWN_EXTENSION_NAME, OWN_TMUX_BASH_BUNDLE };
export const INTENDED_EVAL_SCRIPT = "test:eval:pi-tmux-bash";
export const INTENDED_EVAL_COMMAND =
  "bun run build && LARKIN_RUN_PI_TMUX_BASH_EVAL=1 LARKIN_PI_TMUX_BASH_EVAL_MODEL=openai-codex/gpt-5.6-luna bun test --max-concurrency 1 test/live/pi-tmux-bash-live.test.mjs";
export const HEADLESS_PI_RPC_PREFIX = ["--mode", "rpc", "--no-session", "--no-context-files"];
export const LOCAL_PI_MODELS = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-luna",
  "zai-coding-cn/glm5.3",
];
export const UNAVAILABLE_PI_MODELS = ["opencode-go/deepseek-v4-flash"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isolatedWorkspaces = new Map();

export function userPiAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent");
}

export function resolveOwnTmuxBashBundle(root = ROOT, env = process.env) {
  const override = String(env.LARKIN_PI_TMUX_BASH_EXTENSION || "").trim();
  if (override) return path.resolve(override);
  return path.join(root, OWN_TMUX_BASH_BUNDLE);
}

export function readOwnBuildRevision(root = ROOT, env = process.env) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bundle = path.join(root, OWN_TMUX_BASH_BUNDLE);
  const resolved = resolveOwnTmuxBashBundle(root, env);
  return {
    name: OWN_EXTENSION_NAME,
    distribution: "larkin-owned-bundle",
    bundle: OWN_TMUX_BASH_BUNDLE,
    entry: "src/runtime/pi-tmux-extension.ts",
    core: "src/runtime/pi-tmux.ts",
    package_version: pkg.version,
    bundle_sha256: fs.existsSync(resolved) ? createHash("sha256").update(fs.readFileSync(resolved)).digest("hex") : null,
    bundle_ready: fs.existsSync(bundle),
    resolved,
    revision_source: "own-package-version+bundle",
    upstream: "not-used",
  };
}

export function requireOwnTmuxBashBundle(root = ROOT, env = process.env) {
  const resolved = resolveOwnTmuxBashBundle(root, env);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Larkin tmux extension not ready: ${resolved}; set LARKIN_PI_TMUX_BASH_EXTENSION to the live entrypoint or wait for ${OWN_TMUX_BASH_BUNDLE}; refusing upstream plugin`);
  }
  return resolved;
}

export function snapshotUserPiSettings(env = process.env) {
  const agentDir = userPiAgentDir(env);
  const settings = path.join(agentDir, "settings.json");
  if (!fs.existsSync(settings)) return { agentDir, settings, exists: false, stat: null, content: null };
  const stat = fs.statSync(settings);
  return {
    agentDir,
    settings,
    exists: true,
    stat: { mtimeMs: stat.mtimeMs, size: stat.size },
    content: fs.readFileSync(settings, "utf8"),
  };
}

export function assertUserPiSettingsUnchanged(snapshot, env = process.env) {
  const current = snapshotUserPiSettings(env);
  if (current.exists !== snapshot.exists) {
    throw new Error("live harness must not create or delete user Pi settings");
  }
  if (!snapshot.exists) return;
  if (current.stat.mtimeMs !== snapshot.stat.mtimeMs || current.stat.size !== snapshot.stat.size
    || current.content !== snapshot.content) {
    throw new Error("live harness must not modify user Pi settings");
  }
}

export function buildPiRpcArgs({ bundlePath, loadMode = "extension", model, extraArgs = [] }) {
  const args = [...HEADLESS_PI_RPC_PREFIX, ...extraArgs];
  if (model) args.push("--model", model);
  if (loadMode === "extension") {
    if (!bundlePath) throw new Error("extension load mode requires the Larkin tmux bundle path");
    args.push("--no-extensions", "-e", bundlePath);
  }
  return args;
}

export function assertHeadlessExtensionFixtureArgs(args, bundlePath) {
  if (!Array.isArray(args)) throw new Error("Pi RPC args must be an array");
  for (const flag of HEADLESS_PI_RPC_PREFIX) {
    if (!args.includes(flag)) throw new Error(`headless Pi fixture missing ${flag}`);
  }
  if (!args.includes("--no-extensions")) throw new Error("headless Pi fixture missing --no-extensions");
  const extensionIndex = args.indexOf("-e");
  if (extensionIndex < 0) throw new Error("headless Pi fixture missing -e");
  if (bundlePath && args[extensionIndex + 1] !== bundlePath) {
    throw new Error(`headless Pi fixture -e path mismatch: ${args[extensionIndex + 1]}`);
  }
  return true;
}

export function createIsolatedTmuxWorkspace(prefixOrOptions = "larkin-tmux-eval-") {
  const options = typeof prefixOrOptions === "string" ? { prefix: prefixOrOptions } : { ...prefixOrOptions };
  const prefix = options.prefix || "larkin-tmux-eval-";
  const gitFixture = options.git === true;
  const withSpaces = options.spaces !== false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workDir = path.join(root, withSpaces ? "work dir" : "work");
  const extConfigDir = path.join(root, "ext-config");
  const outputDir = path.join(root, "tmux-out");
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(extConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  if (gitFixture) {
    const init = spawnSync("git", ["init"], { cwd: workDir, encoding: "utf8" });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  }
  const sessionName = options.sessionName
    || `larkin-tmux-${path.basename(root).replace(/[^a-zA-Z0-9-]/g, "").slice(-16)}`;
  const workspace = {
    root,
    workDir,
    extConfigDir,
    outputDir,
    sessionName,
    gitFixture,
    spacesInPath: workDir.includes(" "),
    stateDir: path.join(root, "state"),
    instances: [],
  };
  isolatedWorkspaces.set(sessionName, workspace);
  return workspace;
}

export function childEnvForIsolatedPi(workspace, env = process.env) {
  const instance = { stateDir: workspace.stateDir, agentId: "tmux-eval", instanceId: randomBytes(8).toString("hex") };
  workspace.instances.push(instance);
  return {
    ...env,
    NO_COLOR: "1",
    PI_EXTENSION_CONFIG_DIR: workspace.extConfigDir,
    PI_OFFLINE: env.PI_OFFLINE || "",
    LARKIN_STATE_DIR: instance.stateDir,
    LARKIN_AGENT_ID: instance.agentId,
    LARKIN_TMUX_INSTANCE_ID: instance.instanceId,
  };
}

export function standingPromptFile(workspace, content) {
  const file = path.join(workspace.root, "standing-prompt.md");
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

export function requireExplicitEvalModel(env = process.env) {
  const model = String(env.LARKIN_PI_TMUX_BASH_EVAL_MODEL || "").trim();
  if (!model) {
    throw new Error("LARKIN_PI_TMUX_BASH_EVAL_MODEL is required for real Pi runs; dataset.model.selection is not a silent fallback");
  }
  if (!/^[^\s/]+\/\S+$/.test(model)) throw new Error("explicit model must be provider/model; actual selection is verified at RPC handshake");
  return model;
}

export function selectedPiModel(state) {
  if (state?.model?.provider && state?.model?.id) return `${state.model.provider}/${state.model.id}`;
  return String(state?.model?.id || "");
}

export function assertRequestedModelUsed(requested, actual) {
  if (requested && requested === actual) return { requested, actual, recorded: actual, matched: true };
  throw new Error(`requested model ${requested || "(none)"} but Pi selected ${actual || "(none)"}; recorded actual=${actual || "(none)"}; refusing silent fallback`);
}

export function buildTimedCommand({ sleepSeconds = 65, marker }) {
  if (!marker) throw new Error("timed command requires a marker");
  const safeMarker = String(marker).replace(/'/g, "");
  return [
    "python3 -c",
    `'import time; start=time.time(); print("LARKIN_CMD_START=%.3f"%start, flush=True); time.sleep(${Number(sleepSeconds)}); end=time.time(); print("LARKIN_CMD_END=%.3f"%end, flush=True); print("LARKIN_CMD_RUNTIME_MS=%d"%int((end-start)*1000), flush=True); print("${safeMarker}", flush=True)'`,
  ].join(" ");
}

export function parseCommandRuntime(text) {
  const encoded = String(text || "");
  const start = /LARKIN_CMD_START=([0-9.]+)/.exec(encoded);
  const end = /LARKIN_CMD_END=([0-9.]+)/.exec(encoded);
  const ms = /LARKIN_CMD_RUNTIME_MS=(\d+)/.exec(encoded);
  if (!start || !end) return null;
  const startSec = Number(start[1]);
  const endSec = Number(end[1]);
  return {
    startSec,
    endSec,
    runtimeMs: ms ? Number(ms[1]) : Math.round((endSec - startSec) * 1000),
  };
}

export function parsePsAxRows(text) {
  return String(text || "").split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: match[1], ppid: match[2], command: match[3] } : null;
  }).filter(Boolean);
}

export function descendantProcesses(rows, rootPid) {
  const wanted = new Set([String(rootPid)]);
  const descendants = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (wanted.has(String(row.ppid)) && !wanted.has(String(row.pid))) {
        wanted.add(String(row.pid));
        descendants.push(row);
        grew = true;
      }
    }
  }
  return descendants;
}

function parseWindowLine(line) {
  const [id, name, panePid, command, panePath, owner] = String(line).split("\t");
  return {
    id,
    name,
    panePid,
    command,
    panePath: panePath || "",
    owner: owner || "",
    taskId: name || "",
  };
}

export function listIsolatedTmuxWindows(sessionName) {
  const listed = spawnSync("tmux", [
    "list-windows", "-t", sessionName, "-F",
    "#{window_id}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{@larkin-tmux-owner}",
  ], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\n").filter(Boolean).map(parseWindowLine);
}

export function listTmuxPanesForCwd(cwd) {
  const listed = spawnSync("tmux", [
    "list-panes", "-a", "-F",
    "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}",
  ], { encoding: "utf8" });
  if (listed.status !== 0) return [];
  const wanted = path.resolve(cwd);
  return listed.stdout.split("\n").filter(Boolean).map((line) => {
    const [session, id, name, panePid, command, panePath] = line.split("\t");
    return { sessionName: session, id, name, panePid, command, panePath, taskId: name || "" };
  }).filter((pane) => path.resolve(pane.panePath || "") === wanted);
}

export function windowsOwnedBy(windows, owner) {
  return (windows || []).filter((window) => window.owner && window.owner === owner);
}

export function taskIdFromBashResult(resultOrText) {
  if (resultOrText && typeof resultOrText === "object") {
    const details = resultOrText.details || resultOrText.result?.details;
    if (details?.taskId != null && String(details.taskId).trim()) return String(details.taskId).trim();
    if (resultOrText.taskId != null && String(resultOrText.taskId).trim()) return String(resultOrText.taskId).trim();
  }
  const text = typeof resultOrText === "string" ? resultOrText : JSON.stringify(resultOrText || "");
  try {
    const parsed = JSON.parse(text);
    const nested = parsed?.details?.taskId || parsed?.taskId;
    if (nested != null && String(nested).trim()) return String(nested).trim();
  } catch {
    // result text is not JSON
  }
  const quoted = /"taskId"\s*:\s*"([^"]+)"/.exec(text);
  return quoted?.[1] || null;
}

export function piSessionIdFromState(state) {
  return String(state?.sessionId || state?.session?.id || state?.id || "");
}

function runningChildFromWindow(window) {
  if (!window?.panePid) return { window: window || null, running: false, processes: [] };
  const listed = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  const processes = descendantProcesses(parsePsAxRows(listed.stdout), window.panePid);
  const running = processes.some((proc) => /\b(sleep|python3?)\b/.test(proc.command))
    || /\b(sleep|python3?)\b/.test(window.command || "");
  return { window, panePid: window.panePid, processes, running };
}

export function inspectRunningTmuxChild(sessionName, taskId, cwd) {
  const workspace = isolatedWorkspaces.get(sessionName);
  if (!workspace || !/^[a-f0-9]{16}$/.test(taskId)) return { window: null, running: false, processes: [] };
  for (const instance of workspace.instances) {
    const manager = createLarkinTmux(instance);
    try { manager.peek(taskId); } catch { continue; }
    const meta = JSON.parse(fs.readFileSync(path.join(manager.root, taskId, "meta.json"), "utf8"));
    if (meta.taskId !== taskId || fs.realpathSync(meta.cwd) !== fs.realpathSync(cwd)) continue;
    const listed = spawnSync("tmux", ["list-panes", "-t", `=${meta.session}`, "-F", "#{window_id}\t#{window_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}"], { encoding: "utf8" });
    if (listed.status === 0 && listed.stdout.trim()) return runningChildFromWindow(parseWindowLine(listed.stdout.trim().split("\n")[0]));
  }
  return { window: null, running: false, processes: [] };
}

export function killIsolatedTmuxSession(sessionName) {
  const workspace = isolatedWorkspaces.get(sessionName);
  if (!workspace) return;
  for (const instance of workspace.instances) {
    const manager = createLarkinTmux(instance);
    for (const task of manager.list()) if (task.status === "running") manager.kill(task.taskId);
  }
  // The small terminal-list unit fixture creates this exact synthetic session.
  spawnSync("tmux", ["kill-session", "-t", `=${sessionName}`], { encoding: "utf8" });
}

export function waitFor(trace, predicate, timeoutMs = 240_000, intervalMs = 250) {
  const existing = trace.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = trace.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("eval wait timeout"));
      }
    }, intervalMs);
  });
}

export function spawnPiRpc({ args, cwd, env }) {
  const command = env.LARKIN_PI_COMMAND || "pi";
  return spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
}

export function repoRoot() {
  return ROOT;
}
