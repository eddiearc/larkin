import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import {
  assertCompatibleGlobalLarkCliInLoginShell,
  assertRuntimeCliBindingReady,
  createRuntimeCliBinding,
  ensureCompatibleGlobalLarkCli,
  readCompatibleGlobalLarkCli,
} from "../../../dist/app/runtime-cli-binding.mjs";

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture(version = "9.8.7") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-cli-binding-"));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const executable = path.join(root, "lark-cli");
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ name: "lark-cli", version: "VERSION", runtimeDelegateProtocol: 1 }).replace("VERSION", version)}'\n`, { mode: 0o700 });
  const shell = path.join(root, "login-shell");
  fs.writeFileSync(shell, "#!/bin/sh\ntest \"$1\" = -lc || exit 91\nexec /bin/sh -c \"$2\"\n", { mode: 0o700 });
  return { root, executable, shell };
}

function successfulProbe(executable, version = "9.8.7") {
  return { status: 0, stdout: `__LARKIN_CLI_PATH__${executable}\n${JSON.stringify({ name: "lark-cli", version, runtimeDelegateProtocol: 1 })}\n`, stderr: "" };
}

test("setup trusts protocol handshake and records the actual global CLI version", () => {
  const { root, executable } = fixture("2.4.6");
  const calls = [];
  const record = ensureCompatibleGlobalLarkCli(root, { shell: "/bin/sh", spawn(command, args) {
    calls.push([command, args]);
    return successfulProbe(executable, "2.4.6");
  } });
  assert.equal(record.version, "2.4.6");
  assert.equal(record.executable, fs.realpathSync(executable));
  assert.equal(calls.length, 1);
  assert.deepEqual(readCompatibleGlobalLarkCli(root), record);
  assert.equal(fs.statSync(path.join(root, "runtime", "lark-cli.json")).mode & 0o777, 0o600);
});

test("setup installs latest only after a failed real-shell probe and then re-probes", () => {
  const { root, executable } = fixture();
  const calls = [];
  ensureCompatibleGlobalLarkCli(root, { shell: "/bin/zsh", spawn(command, args, options) {
    calls.push([command, args, options]);
    if (calls.length === 1) return { status: 127, stdout: "", stderr: "" };
    if (calls.length === 2) return { status: 0, stdout: "", stderr: "" };
    return successfulProbe(executable);
  } });
  assert.equal(calls[0][0], "/bin/zsh");
  assert.deepEqual(calls[1].slice(0, 2), ["npm", ["install", "-g", "@larksuite/cli@latest"]]);
  assert.equal(calls[1][2].stdio, undefined, "npm diagnostics must be captured rather than inherited");
  assert.equal(calls[2][0], "/bin/zsh");
  assert.equal(calls[0][1][0], "-lc");
});

test("setup install failure never discloses registry or proxy credentials", () => {
  const { root } = fixture();
  let call = 0;
  assert.throws(() => ensureCompatibleGlobalLarkCli(root, { spawn() {
    call += 1;
    if (call === 1) return { status: 127, stdout: "", stderr: "" };
    return { status: 1, stdout: "https://user:token@registry.invalid", stderr: "proxy password=secret" };
  } }), (error) => {
    assert.match(error.message, /exit=1/);
    assert.doesNotMatch(error.message, /token|password|registry|proxy|secret/i);
    return true;
  });
});

test("readiness rejects a login-shell CLI that changed after setup", () => {
  const { root, executable, shell } = fixture();
  ensureCompatibleGlobalLarkCli(root, { spawn: () => successfulProbe(executable) });
  const old = path.join(root, "old");
  fs.mkdirSync(old, { mode: 0o700 });
  fs.writeFileSync(path.join(old, "lark-cli"), "#!/bin/sh\nprintf '%s\\n' '{\"name\":\"lark-cli\",\"version\":\"old\",\"runtimeDelegateProtocol\":0}'\n", { mode: 0o700 });
  assert.throws(() => assertCompatibleGlobalLarkCliInLoginShell(root, {
    shell, env: { ...process.env, PATH: `${old}:${process.env.PATH || ""}` },
  }), /login shell.*setup/i);
});

test("each Agent gets an isolated private descriptor and binding environment", () => {
  const { root, executable, shell } = fixture();
  ensureCompatibleGlobalLarkCli(root, { spawn: () => successfulProbe(executable) });
  const makeAgent = (agentId) => {
    const stateDir = path.join(root, "state", "agents", agentId);
    const larkConfigDir = path.join(stateDir, "lark-cli-config");
    fs.mkdirSync(larkConfigDir, { recursive: true, mode: 0o700 });
    return { agentId, stateDir, larkConfigDir };
  };
  const bindingEnv = { ...process.env, SHELL: shell, PATH: `${root}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: root };
  const first = createRuntimeCliBinding(makeAgent("cli_First1"), bindingEnv);
  const second = createRuntimeCliBinding(makeAgent("cli_Second2"), bindingEnv);
  assert.notEqual(first.descriptor, second.descriptor);
  assert.notEqual(first.bindingId, second.bindingId);
  assert.equal(first.env.LARK_CLI_RUNTIME_DELEGATE, first.descriptor);
  assert.equal(first.env.LARK_CLI_RUNTIME_PROTOCOL, "1");
  assert.equal(fs.statSync(first.descriptor).mode & 0o777, 0o600);
  const document = JSON.parse(fs.readFileSync(first.descriptor, "utf8"));
  assert.equal(document.context.agentId, "cli_First1");
  assert.equal(document.context.nativeCli, fs.realpathSync(executable));
  assert.equal(document.context.nativeVersion, "9.8.7");
  assert.equal(document.delegateArgs.at(-1), "runtime-cli-delegate");
  assert.doesNotThrow(() => assertRuntimeCliBindingReady(first, bindingEnv));
});

test("binding rejects non-private or symlinked Agent state paths", () => {
  const { root, executable } = fixture();
  ensureCompatibleGlobalLarkCli(root, { spawn: () => successfulProbe(executable) });
  const stateDir = path.join(root, "state", "agents", "cli_Unsafe1");
  const larkConfigDir = path.join(stateDir, "lark-cli-config");
  fs.mkdirSync(larkConfigDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o755);
  assert.throws(() => createRuntimeCliBinding({ agentId: "cli_Unsafe1", stateDir, larkConfigDir }, { ...process.env, LARKIN_CONFIG_DIR: root }), /不安全.*目录/);
  fs.chmodSync(stateDir, 0o700);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.renameSync(larkConfigDir, path.join(root, "saved-config"));
  fs.symlinkSync(outside, larkConfigDir);
  assert.throws(() => createRuntimeCliBinding({ agentId: "cli_Unsafe1", stateDir, larkConfigDir }, { ...process.env, LARKIN_CONFIG_DIR: root }), /不安全.*目录/);
});
