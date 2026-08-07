import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.LARKIN_RUN_COMPILED_RUNTIME_MOCK_E2E === "1";

function checked(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(read, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    try { value = await read(); } catch { /* not ready */ }
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 8_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function rows(file) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeOfficialLarkCli(mockBin) {
  const packageDir = path.join(path.dirname(mockBin), "official", "node_modules", "@larksuite", "cli");
  const launcher = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.79\\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then
  printf '%s\\n' 'Usage: config bind --source lark-channel --identity bot-only'
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs"),path=require("node:path"),source=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600})'
  exit $?
fi
case "$*" in
  *+chat-list*) printf '%s\\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}' ;;
esac
exit 0
`, { mode: 0o755 });
  fs.symlinkSync(launcher, path.join(mockBin, "lark-cli"));
  const loginShell = path.join(mockBin, "fixture-login-shell");
  fs.writeFileSync(loginShell, "#!/bin/sh\nexec /bin/sh -c \"$2\"\n", { mode: 0o755 });
  return loginShell;
}

const codexFixtureSource = `import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-fixture 1.0.0"); process.exit(0); }
const marker = process.env.RUNTIME_PROTOCOL_MARKER;
const record = (value) => fs.appendFileSync(marker, JSON.stringify(value) + "\\n");
record({ type: "launch", runtime: "codex", args: process.argv.slice(2) });
let threadId = "thread-compiled-codex";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { userAgent: "compiled-fixture" } }) + "\\n");
    return;
  }
  if (request.method === "model/list") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ id: "codex-native-model", model: "codex-native-model", displayName: "Codex Native", isDefault: true, hidden: false, supportedReasoningEfforts: [] }] } }) + "\\n");
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    record({ type: "protocol", runtime: "codex", method: request.method, params: request.params });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: threadId } } }) + "\\n");
    return;
  }
  if (request.method === "turn/start") {
    const turnId = "turn-compiled-codex";
    record({ type: "protocol", runtime: "codex", method: request.method, params: request.params });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");
    return;
  }
  if (request.method === "turn/steer") {
    record({ type: "protocol", runtime: "codex", method: request.method, params: request.params });
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
  }
});
`;

const claudeFixtureSource = `import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("claude-fixture 1.0.0"); process.exit(0); }
const marker = process.env.RUNTIME_PROTOCOL_MARKER;
const record = (value) => fs.appendFileSync(marker, JSON.stringify(value) + "\\n");
record({ type: "launch", runtime: "claude", args: process.argv.slice(2) });
let count = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "control_request" && request.request?.subtype === "list_models") {
    process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: request.request_id, subtype: "success", response: { models: [
      { value: "default", resolvedModel: "claude-native-model" }, { value: "claude-native-model", displayName: "Claude Native" },
    ] } } }) + "\\n");
    return;
  }
  count += 1;
  record({ type: "protocol", runtime: "claude", method: request.type, count, request });
  if (count === 1) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "session-compiled-claude" }) + "\\n");
    setTimeout(() => process.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-compiled-claude", message: { content: [{ type: "text", text: "boundary" }] } }) + "\\n"), 750);
  }
});
`;

const piFixtureSource = `import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("0.82.1"); process.exit(0); }
const marker = process.env.RUNTIME_PROTOCOL_MARKER;
const record = (value) => fs.appendFileSync(marker, JSON.stringify(value) + "\\n");
const model = { provider: "fixture", id: "pi-fixture", name: "Pi Fixture", reasoning: false, contextWindow: 32000 };
record({ type: "launch", runtime: "pi", args: process.argv.slice(2) });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true,
    data: { sessionId: "session-compiled-pi", sessionFile: "/tmp/session-compiled-pi.jsonl", model, thinkingLevel: "off", isStreaming: false } }) + "\\n");
  else if (request.type === "get_available_models") process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true,
    data: { models: [model] } }) + "\\n");
  else if (request.type === "prompt" || request.type === "steer") {
    record({ type: "protocol", runtime: "pi", method: request.type, request });
    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true }) + "\\n");
    if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\\n");
    else {
      process.stdout.write(JSON.stringify({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  } else if (request.type === "abort") process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true }) + "\\n");
});
`;

test.skipIf(!enabled)("one compiled binary exercises native Codex/Claude/Pi protocols and hidden process dispatch", {
  timeout: 240_000,
}, async () => {
  assert.ok(process.versions.bun, "this compiled integration must run under the pinned Bun runtime");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-compiled-runtime-native-"));
  const releaseDir = path.join(temp, "release");
  const buildEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };
  try {
    checked(process.execPath, ["run", "build"], { cwd: ROOT, env: buildEnv, timeout: 120_000 }, "build production dist");
    checked(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", releaseDir, "--allow-dirty"], {
      cwd: ROOT, env: buildEnv, timeout: 120_000,
    }, "compile native artifact");
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);

    for (const runtime of ["codex", "claude", "pi"]) {
      const home = path.join(temp, `${runtime}-home`);
      const larkinHome = path.join(home, "larkin");
      const mockBin = path.join(home, "bin");
      const agentId = `cli_${runtime}Native1`;
      const model = runtime === "pi" ? "fixture/pi-fixture" : `${runtime}-native-model`;
      const protocolMarker = path.join(home, "protocol.ndjson");
      const eventFile = path.join(larkinHome, "events.ndjson");
      fs.mkdirSync(mockBin, { recursive: true, mode: 0o700 });
      fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
      fs.chmodSync(home, 0o700);
      fs.chmodSync(larkinHome, 0o700);
      fs.writeFileSync(eventFile, "");
      const loginShell = writeOfficialLarkCli(mockBin);
      if (runtime === "codex" || runtime === "claude" || runtime === "pi") {
        const source = path.join(home, `${runtime}-fixture.mjs`);
        fs.writeFileSync(source, runtime === "codex" ? codexFixtureSource : runtime === "claude" ? claudeFixtureSource : piFixtureSource, { mode: 0o600 });
        checked(process.execPath, ["build", source, "--compile", "--minify", `--outfile=${path.join(mockBin, runtime)}`], {
          cwd: home, env: buildEnv, timeout: 60_000,
        }, `compile ${runtime} protocol fixture`);
      }
      fs.writeFileSync(path.join(larkinHome, "config.json"), `${JSON.stringify({
        version: 4, serverId: `compiled-${runtime}`, mentionPolicy: "free", activeAgent: agentId,
        agents: { [agentId]: { runtime, model } },
      }, null, 2)}\n`, { mode: 0o600 });
      const botsDir = path.join(larkinHome, "bots");
      fs.mkdirSync(botsDir, { mode: 0o700 });
      fs.writeFileSync(path.join(botsDir, `${agentId}.json`), `${JSON.stringify({ appId: agentId, appSecret: "fixture-secret", tenant: "feishu" })}\n`, { mode: 0o600 });
      const serviceEnv = {
        PATH: `${mockBin}:/usr/bin:/bin`, HOME: home, SHELL: loginShell, TMPDIR: os.tmpdir(), LARKIN_CONFIG_DIR: larkinHome,
        LARKIN_DASHBOARD_PORT: String(await freePort()), LARKIN_FEISHU_EVENT_FILE: eventFile,
        RUNTIME_PROTOCOL_MARKER: protocolMarker,
        ...(runtime === "codex" ? { LARKIN_CODEX_COMMAND: path.join(mockBin, "codex") } : {}),
        ...(runtime === "pi" ? { LARKIN_PI_COMMAND: path.join(mockBin, "pi") } : {}),
      };
      let stdout = "", stderr = "";
      const service = spawn(artifact, ["start", "--dry-run"], { cwd: home, env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] });
      service.stdout.on("data", (chunk) => { stdout += chunk; });
      service.stderr.on("data", (chunk) => { stderr += chunk; });
      const output = () => `runtime=${runtime}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
      try {
        const records = await waitFor(() => {
          const read = (name) => JSON.parse(fs.readFileSync(path.join(larkinHome, name), "utf8"));
          const current = { supervisor: read("supervisor-status.json"), daemon: read("daemon-status.json"), dashboard: read("dashboard-status.json") };
          return /agent:status .* active/.test(stderr) ? current : null;
        }, `${runtime} native adapter readiness`).catch((error) => { throw new Error(`${error.message}\n${output()}`); });
        assert.deepEqual(Object.fromEntries(Object.entries(records).map(([name, record]) => [name, record.commandToken])), {
          supervisor: "__internal run", daemon: "__internal runtime-process", dashboard: "__internal dashboard",
        }, output());
        for (const [name, record] of Object.entries(records)) {
          const command = checked("/bin/ps", ["-p", String(record.pid), "-o", "command="], {}, `${name} command`).stdout.trim();
          assert.match(command, new RegExp(`${regexEscape(path.basename(artifact))}.*${regexEscape(record.commandToken)}`), output());
        }
        assert.equal((await fetch(records.dashboard.url)).status, 200, output());
        const event = (index) => ({
          chat_id: `oc_${runtime}_native`, chat_type: "p2p", sender_id: "ou_native_sender",
          message_id: `om_${runtime}_native_${index}`, event_id: `evt_${runtime}_native_${index}`,
          content: `${runtime} native event ${index}`, create_time: String(1785000000000 + index), thread_id: null,
          _mentioned_bot: true, _mention_all: false, _sender_is_bot: false,
        });
        fs.appendFileSync(eventFile, `${JSON.stringify(event(1))}\n`);
        await waitFor(() => rows(protocolMarker).some((row) => row.type === "protocol" && (runtime === "codex" ? row.method === "turn/start" : runtime === "claude" ? row.count === 1 : row.method === "prompt")), `${runtime} first native protocol input`);
        fs.appendFileSync(eventFile, `${JSON.stringify(event(2))}\n`);
        if (runtime === "codex") {
          await waitFor(() => rows(protocolMarker).some((row) => row.method === "turn/steer"), "Codex turn/steer");
        } else if (runtime === "claude") {
          await waitFor(() => rows(protocolMarker).some((row) => row.count === 2), "Claude gated second user input");
        } else await waitFor(() => rows(protocolMarker).some((row) => row.method === "steer"), "Pi RPC steer");
        const drained = checked(artifact, ["__internal", "agent-cli", "inbox", "poll"], {
          cwd: home, env: { ...serviceEnv, LARKIN_AGENT_ID: agentId }, timeout: 15_000,
        }, `${runtime} compiled CLI drain`);
        const result = JSON.parse(drained.stdout);
        assert.deepEqual(result.events.map((row) => row.message_id), [`om_${runtime}_native_1`, `om_${runtime}_native_2`]);
        assert.equal(result.consumed_delivery_ids.length, 2, output());
        if (runtime === "codex") {
          const protocol = rows(protocolMarker);
          assert.deepEqual(protocol.find((row) => row.type === "launch" && row.args.includes("--listen")).args, ["app-server", "--listen", "stdio://"]);
          const thread = protocol.find((row) => row.method === "thread/start");
          assert.match(thread.params.developerInstructions, /inbox check/);
          assert.match(thread.params.developerInstructions, /Collaboration and delivery/);
          assert.equal(Object.keys(thread.params).filter((key) => /instructions|prompt/i.test(key)).length, 1);
        } else if (runtime === "claude") {
          const launch = rows(protocolMarker).find((row) => row.type === "launch" && row.args.includes("--append-system-prompt-file"));
          assert.ok(launch.args.includes("--input-format") && launch.args.includes("stream-json"));
          assert.equal(launch.args.filter((arg) => arg === "--append-system-prompt-file").length, 1);
          assert.equal(launch.args.includes("--system-prompt"), false);
          assert.match(fs.readFileSync(launch.args[launch.args.indexOf("--append-system-prompt-file") + 1], "utf8"), /Collaboration and delivery/);
        } else {
          const protocol = rows(protocolMarker);
          const launch = protocol.find((row) => row.type === "launch" && row.args.includes("--session-dir"));
          assert.deepEqual(launch.args.slice(0, 2), ["--mode", "rpc"]);
          assert.equal(launch.args.filter((arg) => arg === "--append-system-prompt").length, 1);
          assert.equal(launch.args.includes("--system-prompt"), false);
          assert.match(fs.readFileSync(launch.args[launch.args.indexOf("--append-system-prompt") + 1], "utf8"), /Collaboration and delivery/);
          const methods = protocol.filter((row) => row.type === "protocol").map((row) => row.method);
          assert.deepEqual(methods.slice(0, 2), ["prompt", "steer"]);
          assert.equal(methods.slice(2).every((method) => method === "prompt"), true,
            "durable owners remaining after the settled steer must resume through prompt, not repeat busy steer");
        }
        const workspace = path.join(larkinHome, "agents", agentId);
        for (const name of ["AGENTS.md", "CLAUDE.md"]) assert.equal(fs.existsSync(path.join(workspace, name)), false);
      } finally {
        await stop(service);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test.skipIf(!enabled)("compiled Pi provider auth failure projects unauthenticated readiness and recovers after a successful turn", {
  timeout: 180_000,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-compiled-pi-auth-"));
  const releaseDir = path.join(temp, "release");
  const home = path.join(temp, "home");
  const larkinHome = path.join(home, "larkin");
  const mockBin = path.join(home, "bin");
  const eventFile = path.join(larkinHome, "events.ndjson");
  const authProtocolMarker = path.join(home, "pi-auth-protocol.ndjson");
  const allowAuthSuccess = path.join(home, "allow-auth-success");
  const agentId = "cli_compiledPiAuthA1";
  const buildEnv = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` };
  let service;
  try {
    fs.mkdirSync(mockBin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(eventFile, "");
    checked(process.execPath, ["run", "build"], { cwd: ROOT, env: buildEnv, timeout: 120_000 }, "build provider-auth dist");
    checked(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", releaseDir, "--allow-dirty"], {
      cwd: ROOT, env: buildEnv, timeout: 120_000,
    }, "compile provider-auth artifact");
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    const loginShell = writeOfficialLarkCli(mockBin);
    const piSource = path.join(home, "pi-auth-fixture.mjs");
    fs.writeFileSync(piSource, `import fs from "node:fs";
import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("0.82.1"); process.exit(0); }
const model = { provider: "bigmodel-anthropic", id: "glm-5.2", name: "GLM Fixture", reasoning: false, contextWindow: 32000 };
let promptCount = 0;
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (value) => fs.appendFileSync(process.env.PI_AUTH_PROTOCOL_MARKER, JSON.stringify(value) + "\\n");
const successfulTurn = () => {
  record({ type: "boundary", event: "turn_start" });
  output({ type: "turn_start", turnIndex: promptCount - 1 });
  output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "authenticated fixture output" } });
  output({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", provider: "bigmodel-anthropic", stopReason: "stop" }] });
  output({ type: "agent_settled" });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return output({ id: request.id, type: "response", command: request.type, success: true,
    data: { sessionId: "session-compiled-pi-auth", sessionFile: "/tmp/session.jsonl", model, thinkingLevel: "off", isStreaming: false } });
  if (request.type === "get_available_models") return output({ id: request.id, type: "response", command: request.type, success: true, data: { models: [model] } });
  if (request.type === "prompt") {
    promptCount += 1;
    record({ type: "call", method: "prompt", promptCount });
    output({ id: request.id, type: "response", command: request.type, success: true });
    if (promptCount === 1) {
      record({ type: "boundary", event: "turn_start" });
      output({ type: "turn_start", turnIndex: promptCount - 1 });
      output({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", provider: "bigmodel-anthropic",
      stopReason: "error", errorMessage: "API key auth failed at /Users/example/.pi/agent/bin/cc-switch-token; api_key=fixture-secret",
      diagnostics: [{ type: "provider_auth_failure", details: { provider: "bigmodel-anthropic", error: { type: "provider_auth_error", code: "key_command_failed", message: "API key auth failed" } } }] }] });
      output({ type: "agent_settled" });
    } else if (promptCount === 2) {
      record({ type: "boundary", event: "turn_start" });
      output({ type: "turn_start", turnIndex: promptCount - 1 });
      output({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial fixture output" } });
    } else {
      const wait = setInterval(() => {
        if (!fs.existsSync(process.env.PI_AUTH_ALLOW_SUCCESS)) return;
        clearInterval(wait);
        successfulTurn();
      }, 10);
    }
    return;
  }
  if (request.type === "steer") {
    record({ type: "call", method: "steer", promptCount });
    output({ id: request.id, type: "response", command: request.type, success: true });
    output({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", provider: "bigmodel-anthropic", stopReason: "aborted" }] });
    output({ type: "agent_settled" });
    return;
  }
  if (request.type === "abort") output({ id: request.id, type: "response", command: request.type, success: true });
});
`, { mode: 0o600 });
    const piCommand = path.join(mockBin, "pi");
    checked(process.execPath, ["build", piSource, "--compile", "--minify", `--outfile=${piCommand}`], {
      cwd: home, env: buildEnv, timeout: 60_000,
    }, "compile provider-auth Pi fixture");
    fs.writeFileSync(path.join(larkinHome, "config.json"), `${JSON.stringify({
      version: 4, serverId: "compiled-pi-auth", mentionPolicy: "free", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "bigmodel-anthropic/glm-5.2" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const botsDir = path.join(larkinHome, "bots");
    fs.mkdirSync(botsDir, { mode: 0o700 });
    fs.writeFileSync(path.join(botsDir, `${agentId}.json`), `${JSON.stringify({ appId: agentId, appSecret: "fixture-secret", tenant: "feishu" })}\n`, { mode: 0o600 });
    const serviceEnv = {
      PATH: `${mockBin}:/usr/bin:/bin`, HOME: home, SHELL: loginShell, TMPDIR: os.tmpdir(), LARKIN_CONFIG_DIR: larkinHome,
      LARKIN_DASHBOARD_PORT: String(await freePort()), LARKIN_FEISHU_EVENT_FILE: eventFile, LARKIN_PI_COMMAND: piCommand,
      PI_AUTH_PROTOCOL_MARKER: authProtocolMarker, PI_AUTH_ALLOW_SUCCESS: allowAuthSuccess,
    };
    let stdout = "", stderr = "";
    service = spawn(artifact, ["start", "--dry-run"], { cwd: home, env: serviceEnv, stdio: ["ignore", "pipe", "pipe"] });
    service.stdout.on("data", (chunk) => { stdout += chunk; });
    service.stderr.on("data", (chunk) => { stderr += chunk; });
    const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
    const statusFile = path.join(larkinHome, "state", "agents", agentId, "status.json");
    await waitFor(() => {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      return status.runtimeReadiness?.state === "ready" ? status : null;
    }, "initial compiled Pi readiness").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    const event = (suffix) => ({
      chat_id: "oc_compiled_pi_auth", chat_type: "p2p", sender_id: "ou_fixture",
      message_id: `om_compiled_pi_auth_${suffix}`, event_id: `evt_compiled_pi_auth_${suffix}`,
      content: `provider auth ${suffix}`, create_time: String(1785001000000 + suffix), thread_id: null,
      _mentioned_bot: true, _mention_all: false, _sender_is_bot: false,
    });
    fs.appendFileSync(eventFile, `${JSON.stringify(event(1))}\n`);
    const failed = await waitFor(() => {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      return status.runtimeReadiness?.state === "unauthenticated" ? status : null;
    }, "compiled Pi auth downgrade").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    assert.match(failed.runtimeReadiness.reason, /bigmodel-anthropic.*authentication failed/i);
    assert.doesNotMatch(JSON.stringify(failed.runtimeReadiness) + JSON.stringify(failed.recentErrors), /Users\/example|cc-switch-token|fixture-secret/);
    const publicStatus = checked(artifact, ["status"], { cwd: home, env: serviceEnv, timeout: 15_000 }, "compiled public status projection");
    assert.match(publicStatus.stdout, /runtime readiness=unauthenticated/);
    assert.doesNotMatch(publicStatus.stdout + publicStatus.stderr, /Users\/example|cc-switch-token|fixture-secret/);
    const dashboardOwner = JSON.parse(fs.readFileSync(path.join(larkinHome, "dashboard-status.json"), "utf8"));
    const dashboardStatus = await fetch(`${dashboardOwner.url}/api/status`).then((response) => response.json());
    const dashboardAgent = dashboardStatus.agents.find((agent) => agent.agentId === agentId);
    assert.equal(dashboardAgent.runtimeReadiness.state, "unauthenticated");
    assert.doesNotMatch(JSON.stringify(dashboardAgent.runtimeReadiness), /Users\/example|cc-switch-token|fixture-secret/);
    fs.appendFileSync(eventFile, `${JSON.stringify(event(2))}\n`);
    await waitFor(() => {
      const protocol = rows(authProtocolMarker);
      return protocol.filter((row) => row.type === "call").map((row) => row.method).join(",") === "prompt,prompt" ? protocol : null;
    }, "compiled Pi partial retry prompt").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    fs.appendFileSync(eventFile, `${JSON.stringify(event(3))}\n`);
    await waitFor(() => {
      const calls = rows(authProtocolMarker).filter((row) => row.type === "call").map((row) => row.method);
      return calls.join(",") === "prompt,prompt,steer,prompt" ? calls : null;
    }, "compiled Pi aborted boundary serialized retry").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    await waitFor(() => {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      return status.runtimeReadiness?.state === "unauthenticated" ? status : null;
    }, "compiled Pi aborted partial output preserves auth downgrade").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    assert.deepEqual(rows(authProtocolMarker).filter((row) => row.type === "call").map((row) => row.method),
      ["prompt", "prompt", "steer", "prompt"], "aborted boundary starts exactly one serialized retry prompt");
    fs.writeFileSync(allowAuthSuccess, "allow\n", { mode: 0o600 });
    await waitFor(() => JSON.parse(fs.readFileSync(statusFile, "utf8")).runtimeReadiness?.state === "ready",
      "compiled Pi auth recovery").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    await waitFor(() => rows(authProtocolMarker).filter((row) => row.type === "call").length >= 5,
      "compiled Pi remaining owner next-boundary retry").catch((error) => { throw new Error(`${error.message}\n${output()}`); });
    const protocol = rows(authProtocolMarker);
    const recoveredCalls = protocol.filter((row) => row.type === "call");
    assert.deepEqual(recoveredCalls.slice(0, 5).map((row) => row.method),
      ["prompt", "prompt", "steer", "prompt", "prompt"]);
    assert.equal(recoveredCalls.slice(5).every((row) => row.method === "prompt"), true,
      "post-recovery pending owners must continue through prompt boundaries, never busy steer");
    const recoveredPromptCounts = recoveredCalls.filter((row) => row.method === "prompt" && row.promptCount >= 3)
      .map((row) => row.promptCount);
    for (let index = 1; index < recoveredPromptCounts.length; index += 1) {
      const previous = protocol.findIndex((row) => row.type === "call" && row.promptCount === recoveredPromptCounts[index - 1]);
      const current = protocol.findIndex((row) => row.type === "call" && row.promptCount === recoveredPromptCounts[index]);
      assert.ok(protocol.slice(previous + 1, current).some((row) => row.type === "boundary" && row.event === "turn_start"),
        "each remaining pending owner starts only after the preceding retry has a real turn boundary");
    }
  } finally {
    if (service) await stop(service);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
