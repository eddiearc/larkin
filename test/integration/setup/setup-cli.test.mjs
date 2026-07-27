import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const safeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-cli-safe-"));
const safeConfig = path.join(safeRoot, "config");
const blockedRegisterFixture = path.join(safeRoot, "blocked-register.cjs");
fs.writeFileSync(blockedRegisterFixture, `module.exports={registerApp:async()=>{throw new Error("blocked test registration")},qrcode:{generate(){}},spawnSync(){return {status:1,stdout:"",stderr:"blocked test external command"}}};`);
const safeEnv = {
  ...process.env,
  HOME: path.join(safeRoot, "home"),
  LARKIN_HOME: safeConfig,
  LARKIN_CONFIG_DIR: safeConfig,
  LARKSUITE_CLI_CONFIG_DIR: path.join(safeRoot, "lark-cli"),
  LARKIN_TEST_BOT_REGISTER_MODULE: blockedRegisterFixture,
};
process.once("exit", () => fs.rmSync(safeRoot, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, args, { cwd: ROOT, env: safeEnv, encoding: "utf8" });

const help = run("dist/app/cli.mjs", "--help");
assert.equal(help.status, 0);
assert.match(help.stdout, /setup\s+Create or connect a bot/);
assert.match(help.stdout, /status\s+Show Agent configuration/);
assert.match(help.stdout, /First-time setup:\s+larkin setup/);
assert.doesNotMatch(help.stdout, /\binit\b|bot:connect/);

const removedInit = run("dist/app/cli.mjs", "init");
assert.equal(removedInit.status, 1, "init 必须被明确移出公开 CLI，不能兼容转发");
const removedConnect = run("dist/app/cli.mjs", "bot:connect");
assert.equal(removedConnect.status, 1, "bot:connect 必须被明确移出公开 CLI，不能兼容转发");
const removedDashboard = run("dist/app/cli.mjs", "dashboard");
assert.equal(removedDashboard.status, 1, "dashboard 必须被明确移出公开 CLI");
assert.match(removedDashboard.stderr, /已移除.*larkin start/);

const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-cli-help-"));
try {
  const spawnMarker = path.join(isolated, "spawn.ndjson");
  const fsMarker = path.join(isolated, "fs.ndjson");
  const calibrationMarker = path.join(isolated, "fs-calibration.ndjson");
  const preload = path.join(isolated, "preload.cjs");
  fs.writeFileSync(preload, `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const roots = [process.env.CLI_HELP_HOME, process.env.CLI_HELP_CONFIG].map((value) => path.resolve(value));
const marker = process.env.CLI_HELP_FS_MARKER;
const appendMarker = fs.appendFileSync.bind(fs);
// This is a focused tripwire for FS entry points used by current CLI routes and
// common config/state operations. It is intentionally not a complete filesystem sandbox.
function guarded(value) {
  if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return false;
  const candidate = path.resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
  return roots.some((root) => candidate === root || candidate.startsWith(root + path.sep));
}
function display(value) {
  return value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : String(value);
}
function deny(name, values) {
  const denied = values.flatMap(({ value, index }) => guarded(value) ? [{ name, index, path: display(value) }] : []);
  if (denied.length === 0) return;
  for (const entry of denied) appendMarker(marker, JSON.stringify(entry) + "\\n");
  throw new Error("CLI help touched isolated HOME/config via fs." + name + ": " + denied.map(({ path }) => path).join(", "));
}
const singlePath = [
  "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync", "createReadStream", "createWriteStream",
  "exists", "existsSync", "lstat", "lstatSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync",
  "opendir", "opendirSync", "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync",
  "realpath", "realpathSync", "rm", "rmSync", "rmdir", "rmdirSync", "stat", "statSync", "truncate", "truncateSync",
  "unlink", "unlinkSync", "writeFile", "writeFileSync",
];
const dualPath = [
  "copyFile", "copyFileSync", "cp", "cpSync", "link", "linkSync", "rename", "renameSync",
];
for (const name of singlePath) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function(value, ...args) { deny(name, [{ value, index: 0 }]); return original.call(this, value, ...args); };
}
for (const name of dualPath) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function(source, target, ...args) {
    deny(name, [{ value: source, index: 0 }, { value: target, index: 1 }]);
    return original.call(this, source, target, ...args);
  };
}
for (const name of singlePath.filter((name) => !name.endsWith("Sync") && !name.startsWith("create") && name !== "exists")) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = function(value, ...args) { deny("promises." + name, [{ value, index: 0 }]); return original.call(this, value, ...args); };
}
for (const name of dualPath.filter((name) => !name.endsWith("Sync"))) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = function(source, target, ...args) {
    deny("promises." + name, [{ value: source, index: 0 }, { value: target, index: 1 }]);
    return original.call(this, source, target, ...args);
  };
}
for (const name of ["symlink", "symlinkSync"]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function(target, linkPath, ...args) {
    // symlink target may be arbitrary/dangling text; only linkPath creates an FS entry.
    deny(name, [{ value: linkPath, index: 1 }]);
    return original.call(this, target, linkPath, ...args);
  };
}
if (typeof fs.promises.symlink === "function") {
  const originalSymlink = fs.promises.symlink;
  fs.promises.symlink = function(target, linkPath, ...args) {
    deny("promises.symlink", [{ value: linkPath, index: 1 }]);
    return originalSymlink.call(this, target, linkPath, ...args);
  };
}
childProcess.spawn = function(...args) {
  fs.appendFileSync(process.env.CLI_HELP_SPAWN_MARKER, JSON.stringify(args.slice(0, 2)) + "\\n");
  throw new Error("CLI help must not spawn a routed command");
};
require("node:module").syncBuiltinESMExports();
`);
  const configDir = path.join(isolated, "config");
  const isolatedHome = path.join(isolated, "home");
  const calibrationEnv = {
    ...process.env,
    CLI_HELP_FS_MARKER: calibrationMarker,
    CLI_HELP_HOME: isolatedHome,
    CLI_HELP_CONFIG: configDir,
    CLI_HELP_SPAWN_MARKER: spawnMarker,
    BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
  };
  const calibration = spawnSync(process.execPath, ["-e", `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const marker = process.env.CLI_HELP_FS_MARKER;
const home = process.env.CLI_HELP_HOME;
const config = process.env.CLI_HELP_CONFIG;
const safe = path.join(path.dirname(home), "safe");
const records = () => fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
function denied(name, call, expectedIndexes = [0]) {
  const before = records().length;
  assert.throws(call, /touched isolated HOME\\/config/, name + " must throw");
  const added = records().slice(before);
  assert.deepEqual(added.map((entry) => entry.index), expectedIndexes, name + " marker path indexes");
  assert.equal(added.every((entry) => entry.name === name), true, name + " marker operation");
}
(async () => {
denied("accessSync", () => fs.accessSync(path.join(home, "string-path")));
denied("statSync", () => fs.statSync(Buffer.from(path.join(config, "buffer-path"))));
denied("readFileSync", () => fs.readFileSync(pathToFileURL(path.join(home, "url-path"))));
for (const name of ["copyFileSync", "cpSync", "linkSync", "renameSync"]) {
  denied(name, () => fs[name](path.join(home, name + "-source"), safe), [0]);
  denied(name, () => fs[name](safe, pathToFileURL(path.join(config, name + "-target"))), [1]);
  denied(name, () => fs[name](Buffer.from(path.join(home, name + "-both-source")), path.join(config, name + "-both-target")), [0, 1]);
}
for (const name of ["copyFile", "cp", "link", "rename"]) {
  denied(name, () => fs[name](path.join(home, name + "-source"), safe, () => {}), [0]);
  denied(name, () => fs[name](safe, path.join(config, name + "-target"), () => {}), [1]);
  denied("promises." + name, () => fs.promises[name](path.join(home, name + "-promise-source"), safe), [0]);
  denied("promises." + name, () => fs.promises[name](safe, path.join(config, name + "-promise-target")), [1]);
}
const danglingTarget = path.join(home, "allowed-dangling-symlink-target");
const syncLink = safe + "-symlink-sync";
fs.symlinkSync(danglingTarget, syncLink);
assert.equal(fs.lstatSync(syncLink).isSymbolicLink(), true, "symlinkSync HOME target text must be allowed at a safe link path");
fs.unlinkSync(syncLink);
const callbackLink = safe + "-symlink-callback";
await new Promise((resolve, reject) => fs.symlink(danglingTarget, callbackLink, (error) => error ? reject(error) : resolve()));
assert.equal(fs.lstatSync(callbackLink).isSymbolicLink(), true, "symlink callback HOME target text must be allowed at a safe link path");
fs.unlinkSync(callbackLink);
const promiseLink = safe + "-symlink-promise";
await fs.promises.symlink(danglingTarget, promiseLink);
assert.equal(fs.lstatSync(promiseLink).isSymbolicLink(), true, "symlink promise HOME target text must be allowed at a safe link path");
fs.unlinkSync(promiseLink);
denied("symlinkSync", () => fs.symlinkSync(safe, path.join(home, "denied-symlink-sync")), [1]);
denied("symlink", () => fs.symlink(safe, path.join(config, "denied-symlink-callback"), () => {}), [1]);
denied("promises.symlink", () => fs.promises.symlink(safe, path.join(home, "denied-symlink-promise")), [1]);
for (const name of ["mkdtempSync", "readlinkSync", "truncateSync"]) {
  denied(name, () => fs[name](path.join(config, name)));
}
for (const name of ["mkdtemp", "rmdir", "readlink", "truncate"]) {
  denied(name, () => fs[name](path.join(config, name), () => {}));
  denied("promises." + name, () => fs.promises[name](path.join(home, name)));
}
const createThenDelete = path.join(home, "must-never-exist");
denied("mkdirSync", () => fs.mkdirSync(createThenDelete));
denied("rmdirSync", () => fs.rmdirSync(createThenDelete));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`], { cwd: ROOT, env: calibrationEnv, encoding: "utf8" });
  assert.equal(calibration.status, 0, `filesystem guard self-calibration failed: ${calibration.stderr}`);
  assert.equal(fs.existsSync(calibrationMarker), true, "filesystem guard calibration must record denied attempts");
  assert.equal(fs.existsSync(path.join(isolatedHome, "must-never-exist")), false, "guard calibration must not create its test path");
  const env = {
    ...process.env,
    HOME: isolatedHome,
    LARKIN_CONFIG_DIR: configDir,
    CLI_HELP_SPAWN_MARKER: spawnMarker,
    CLI_HELP_FS_MARKER: fsMarker,
    CLI_HELP_HOME: isolatedHome,
    CLI_HELP_CONFIG: configDir,
    BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
  };
  for (const command of ["start", "status", "setup", "model", "runtime", "effort", "chats", "agents"]) {
    for (const flag of ["--help", "-h"]) {
      const result = spawnSync(process.execPath, ["dist/app/cli.mjs", command, flag], { cwd: ROOT, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${command} ${flag} must exit 0 without loading its route: ${result.stderr}`);
      assert.match(result.stdout + result.stderr, new RegExp(`larkin\\s+${command}|Usage:[^\\n]*${command}`, "i"), `${command} ${flag} output`);
      if (command === "chats") {
        assert.match(result.stdout, /Usage:\s*larkin chats \[--agent <App ID>\]\n\s+larkin chats \(free\|strict\) <oc_id> \[--agent <App ID>\]/);
      }
      assert.equal(fs.existsSync(spawnMarker), false, `${command} ${flag} spawned a routed child`);
      assert.equal(fs.existsSync(fsMarker), false, `${command} ${flag} touched isolated HOME/config`);
      assert.equal(fs.existsSync(isolatedHome), false, `${command} ${flag} created then retained HOME content`);
      assert.equal(fs.existsSync(configDir), false, `${command} ${flag} created then retained config/state`);
    }
  }
  const removedBuild = spawnSync(process.execPath, ["dist/app/cli.mjs", "build", "--help"], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(removedBuild.status, 1, "removed build command must fail locally");
  assert.match(removedBuild.stderr, /已移除.*bun run build/);
  assert.equal(fs.existsSync(spawnMarker), false, "removed build command spawned a child");
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}

const setupHelp = run("dist/app/setup.mjs", "--help");
assert.equal(setupHelp.status, 0);
assert.match(setupHelp.stdout, /Each Agent is identified by its bot App ID/);
assert.match(setupHelp.stdout, /selecting\s+the same bot reuses\s+its existing Agent, memory, and state/);
assert.doesNotMatch(setupHelp.stdout, /--no-dashboard/);
assert.match(setupHelp.stdout, /target-only hot attach|only the selected Agent/i);
assert.doesNotMatch(setupHelp.stdout, /--app-id/);

const publicSetupHelp = run("dist/app/cli.mjs", "setup", "--help");
assert.equal(publicSetupHelp.status, 0);
assert.doesNotMatch(publicSetupHelp.stdout, /--app-id/);

for (const removedAppIdArg of [["--app-id", "cli_removed"], ["--app-id=cli_removed"]]) {
  const removedAppId = run("dist/app/setup.mjs", ...removedAppIdArg);
  assert.equal(removedAppId.status, 1, `setup ${removedAppIdArg.join(" ")} 必须被拒绝`);
  assert.match(removedAppId.stderr, /不支持 --app-id/);
}
const removedNoDashboard = run("dist/app/setup.mjs", "--no-dashboard");
assert.equal(removedNoDashboard.status, 1);
assert.match(removedNoDashboard.stderr, /--no-dashboard 已移除.*larkin start/);

const setupRuntime = fs.readFileSync(path.join(ROOT, "dist/app/setup.mjs"), "utf8");
assert.match(setupRuntime, /^#!\/usr\/bin\/env bun/);
assert.match(setupRuntime, /main\(\)\.catch/);
assert.doesNotMatch(setupRuntime, /packages\/larkin-shell|fork\/feishu/);
const setupSource = fs.readFileSync(path.join(ROOT, "src/app/setup.ts"), "utf8");
assert.match(setupSource, /acquireProcessLock\(path\.join\(CFG_DIR, "setup\.lock\.json"\)/);
assert.match(setupSource, /process\.on\("exit", releaseMutationLock\)/);
assert.match(setupSource, /!OPT\.start[\s\S]*releaseMutationLock\(\)/);
assert.match(setupSource, /requestAgentUpsert\(\{ larkinHome: CFG_DIR, agentId: selectedAgentId \}\)/);
assert.doesNotMatch(setupSource, /stopDaemonForReload|terminateOwnedProcess|dashboard\.mjs/);
assert.doesNotMatch(setupSource, /\bpreviousAgentId\b|\binferRunningAgents\b|workspace-service|reconcileAgentWorkspace/);
assert.doesNotMatch(setupSource, /flag\("--app-id"\)|OPT\.appId/);
const registerSource = fs.readFileSync(path.join(ROOT, "src/setup/bot-register.ts"), "utf8");
assert.doesNotMatch(registerSource, /\bpinAppId\b|appId:\s*pinAppId/);
assert.equal(fs.existsSync(path.join(ROOT, "dist/init.mjs")), false);
assert.equal(fs.existsSync(path.join(ROOT, "dist/bot-connect.mjs")), false);

const parseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bun-parse-"));
try {
  for (const [index, script] of [
    "dist/app/cli.mjs",
    "dist/app/setup.mjs",
    "dist/setup/setup-bind.mjs",
    "dist/setup/bot-register.mjs",
    "dist/platform/process-state.mjs",
    "dist/app/run.mjs",
    "dist/app/dashboard.mjs",
    "test/support/host-shell-test-harness.cjs",
  ].entries()) {
    const checked = run("build", "--target=bun", `--outfile=${path.join(parseRoot, `${index}.mjs`)}`, script);
    assert.equal(checked.status, 0, `${script} 必须通过 Bun bundle parse-check：${checked.stderr}`);
  }
} finally {
  fs.rmSync(parseRoot, { recursive: true, force: true });
}

console.log("  ✓ setup 是唯一 onboarding，旧 init/bot:connect 不兼容保留");
