import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRY = path.join(ROOT, "dist", "app", "agent-config.mjs");
const PUBLIC_ENTRY = path.join(ROOT, "dist", "app", "cli.mjs");
const { inspectProcess } = await import(pathToFileURL(path.join(ROOT, "dist", "platform", "process-state.mjs")).href);

test("Pi default model label is concise and does not claim an official default", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "app", "agent-config.ts"), "utf8");
  assert.match(source, /label: `default: \$\{loadedPiCatalog\.effectiveModel\}`/);
  assert.doesNotMatch(source, /官方默认/);
});

test("document-comment diagnostics expose stable request, event, and read/access categories without provider content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-comment-readiness-"));
  const app = "cli_commentReadinessA1";
  try {
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-comment-readiness", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "codex", model: "default" } },
    })}\n`, { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [ENTRY, "agents", "--json"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: root },
    });
    const diagnostic = () => {
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).agents[0].document_comment;
    };
    assert.deepEqual({ category: diagnostic().category, reason: diagnostic().reason }, {
      category: "not_requested", reason: "setup_required",
    });
    assert.deepEqual(diagnostic().subscription, { mode: "none", status: "safe-default", source: "legacy-default", dimension: null });
    fs.mkdirSync(path.join(root, "bots"), { mode: 0o700 });
    fs.writeFileSync(path.join(root, "bots", `${app}.json`), JSON.stringify({ appId: app, appSecret: "fixture", tenant: "feishu", capabilities: {
      documentCommentEvent: { status: "requested-unverified", event: "drive.notice.comment_add_v1", scope: "drive:drive", requestedAt: "2026-08-05T00:00:00.000Z" },
      documentCommentReply: { status: "requested-unverified", scope: "docs:document.comment:create", requestedAt: "2026-08-05T00:00:10.000Z" },
    } }), { mode: 0o600 });
    assert.deepEqual({ category: diagnostic().category, reason: diagnostic().reason }, {
      category: "publish_or_event_unverified", reason: "publication_and_real_event_unverified",
    });
    const credentialFile = path.join(root, "bots", `${app}.json`);
    const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    credential.capabilities.documentCommentSubscription = {
      mode: "subscribed", status: "platform-verified", source: "platform-status", dimension: "application",
      requestedAt: "2026-08-05T00:00:00.000Z", verifiedAt: "2026-08-05T00:00:30.000Z",
    };
    fs.writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
    assert.deepEqual(diagnostic().subscription, {
      mode: "subscribed", status: "platform-verified", source: "platform-status", dimension: "application",
    });
    assert.deepEqual({ scope: diagnostic().reply_scope, requestedAt: diagnostic().reply_requested_at }, {
      scope: "docs:document.comment:create", requestedAt: "2026-08-05T00:00:10.000Z",
    });
    fs.chmodSync(credentialFile, 0o644);
    assert.deepEqual(diagnostic().subscription, {
      mode: "none", status: "safe-default", source: "legacy-default", dimension: null,
    });
    assert.equal(diagnostic().reply_requested_at, null);
    fs.chmodSync(credentialFile, 0o600);
    const stateDir = path.join(root, "state", "agents", app);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "status.json"), JSON.stringify({
      documentCommentEventAt: "2026-08-05T00:01:00.000Z",
    }), { mode: 0o600 });
    assert.deepEqual({ category: diagnostic().category, reason: diagnostic().reason }, {
      category: "event_arrived", reason: "real_event_observed",
    });
    for (const category of [
      "permission_missing", "document_access_denied", "comment_unavailable_or_empty", "inbox_write_failure",
      "pending_capacity_exhausted", "read_failure_unknown",
    ]) {
      fs.writeFileSync(path.join(stateDir, "status.json"), JSON.stringify({
        documentCommentEventAt: "2026-08-05T00:01:00.000Z",
        documentCommentLastErrorCategory: category,
        documentCommentLastError: category,
        documentCommentLastErrorAt: "2026-08-05T00:02:00.000Z",
      }), { mode: 0o600 });
      const failed = diagnostic();
      assert.deepEqual({ category: failed.category, reason: failed.reason }, { category, reason: category });
      assert.doesNotMatch(JSON.stringify(failed), /fixture|doc_token|comment body/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("user model CLI accepts a dynamic Codex runtime model and effort across fresh processes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-codex-catalog-cli-"));
  const bin = path.join(temp, "bin");
  const app = "cli_codexCatalogA1";
  try {
    fs.mkdirSync(bin);
    const fakeCodex = path.join(bin, "codex");
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env bun
if (process.argv.slice(2).join(" ") !== "app-server --stdio") process.exit(2);
let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const line=input.slice(0,i);input=input.slice(i+1);const request=JSON.parse(line);if(request.method==="model/list")process.stdout.write(JSON.stringify({id:request.id,result:{data:[{id:"gpt-evaluator-dynamic-1",model:"gpt-evaluator-dynamic-1",displayName:"Evaluator Dynamic",hidden:false,isDefault:true,defaultReasoningEffort:"medium",supportedReasoningEfforts:[{reasoningEffort:"low"},{reasoningEffort:"medium"},{reasoningEffort:"high"}]}]}})+"\\n");}});
`);
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(path.join(temp, "agents", app), { recursive: true });
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-codex-catalog", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "claude", model: "sonnet" } },
    })}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp },
    });

    const switched = run("runtime", "codex", "--model", "gpt-evaluator-dynamic-1", "--agent", app);
    assert.equal(switched.status, 0, switched.stderr);
    const listed = run("model", "--agent", app);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /gpt-evaluator-dynamic-1\s+Evaluator Dynamic/);
    assert.doesNotMatch(listed.stdout, /gpt-5\.3-codex\s/);
    assert.equal(run("model", "default", "--agent", app).status, 0);
    const selected = run("model", "gpt-evaluator-dynamic-1", "--agent", app);
    assert.equal(selected.status, 0, selected.stderr);
    const effort = run("effort", "high", "--agent", app);
    assert.equal(effort.status, 0, effort.stderr);
    const shown = run("config", "show", "--agent", app, "--json");
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(
      { model: JSON.parse(shown.stdout).agents[0].model, effort: JSON.parse(shown.stdout).agents[0].effort },
      { model: "gpt-evaluator-dynamic-1", effort: "high" },
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("user model CLI persists a dynamic Claude model and effort across fresh processes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-claude-catalog-cli-"));
  const bin = path.join(temp, "bin");
  const app = "cli_claudeCatalogA1";
  try {
    fs.mkdirSync(bin);
    const fakeClaude = path.join(bin, "claude");
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env bun
let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const request=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(request.request?.subtype==="list_models")process.stdout.write(JSON.stringify({type:"control_response",response:{request_id:request.request_id,subtype:"success",response:{models:[{value:"default",displayName:"Default",resolvedModel:"claude-sonnet-5",supportsEffort:true,supportedEffortLevels:["low","medium","high"]},{value:"claude-evaluator-9",displayName:"Evaluator Claude",resolvedModel:"claude-evaluator-9",supportsEffort:true,supportedEffortLevels:["low","medium","high"]}]}}})+"\\n");}});
`);
    fs.chmodSync(fakeClaude, 0o755);
    fs.mkdirSync(path.join(temp, "agents", app), { recursive: true });
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-claude-catalog", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "claude", model: "default" } },
    })}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp },
    });
    const listed = run("model", "--agent", app);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /default:\s*claude-sonnet-5/);
    assert.match(listed.stdout, /claude-evaluator-9\s+Evaluator Claude/);
    const defaultEffort = run("effort", "high", "--agent", app);
    assert.equal(defaultEffort.status, 1);
    assert.match(defaultEffort.stdout + defaultEffort.stderr, /不能设置|未显式声明/);
    const selected = run("model", "claude-evaluator-9", "--agent", app);
    assert.equal(selected.status, 0, selected.stderr);
    const effort = run("effort", "medium", "--agent", app);
    assert.equal(effort.status, 0, effort.stderr);
    const shown = run("config", "show", "--agent", app, "--json");
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(
      { model: JSON.parse(shown.stdout).agents[0].model, effort: JSON.parse(shown.stdout).agents[0].effort },
      { model: "claude-evaluator-9", effort: "medium" },
    );
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Pi distribution CLI performs a locked snapshot mutation and rollback", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-distribution-cli-"));
  const app = "cli_piDistributionA1";
  const snapshot = path.join(temp, "pi-distribution.snapshot.json");
  try {
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-pi-distribution", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "pi", model: "default", piDistribution: "external" } },
    })}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp },
    });
    const shown = run("pi-distribution", "show", "--agent", app);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).piDistribution, "external");
    const providerDir = path.join(temp, "providers", "pi", app);
    fs.mkdirSync(providerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(providerDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-only" } }), { mode: 0o600 });
    const changed = run("pi-distribution", "builtin", "--agent", app, "--snapshot", snapshot);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8")).agents[app].piDistribution, "builtin");
    const rollback = run("pi-distribution", "rollback", "--snapshot", snapshot);
    assert.equal(rollback.status, 0, rollback.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8")).agents[app].piDistribution, "external");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Pi distribution CLI refuses builtin without provider state before writing config or snapshot", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-distribution-preflight-"));
  const app = "cli_piDistributionPreflightA1";
  const snapshot = path.join(temp, "pi-distribution.snapshot.json");
  try {
    const initial = `${JSON.stringify({
      version: 4, serverId: "server-pi-distribution-preflight", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "pi", model: "default", piDistribution: "external" } },
    })}\n`;
    fs.writeFileSync(path.join(temp, "config.json"), initial, { mode: 0o600 });
    const result = spawnSync(process.execPath, [ENTRY, "pi-distribution", "builtin", "--agent", app, "--snapshot", snapshot], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /provider 尚未.*配置/);
    assert.doesNotMatch(result.stderr, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.readFileSync(path.join(temp, "config.json"), "utf8"), initial);
    assert.equal(fs.existsSync(snapshot), false, "failed provider preflight must not create a rollback snapshot");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Pi distribution import is explicit, byte-preserving, and reverse rollback removes only the imported target", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-distribution-import-cli-"));
  const app = "cli_piDistributionImportA1";
  const source = path.join(temp, "external");
  const bin = path.join(temp, "bin");
  const target = path.join(temp, "providers", "pi", app);
  const snapshot = path.join(temp, "pi-distribution.snapshot.json");
  try {
    fs.mkdirSync(source, { recursive: true, mode: 0o755 }); fs.mkdirSync(bin, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "pi"), `#!${process.execPath}\nconsole.log("0.84.2")\n`, { mode: 0o700 });
    fs.writeFileSync(path.join(source, "auth.json"), JSON.stringify({ fixture: { key: "PRIVATE" } }) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(source, "models.json"), JSON.stringify({ providers: { fixture: {} } }) + "\n", { mode: 0o644 });
    fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ theme: "dark", compaction: { enabled: false } }) + "\n", { mode: 0o644 });
    const initial = { version: 4, serverId: "server-pi-distribution-import", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "pi", model: "fixture/model", piDistribution: "external" } } };
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify(initial)}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { cwd: ROOT, encoding: "utf8",
      env: { ...process.env, HOME: temp, PATH: `${bin}:/usr/bin:/bin`, LARKIN_CONFIG_DIR: temp, PI_CODING_AGENT_DIR: source } });
    const imported = run("pi-distribution", "builtin", "--agent", app, "--snapshot", snapshot, "--import-external-profile");
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(fs.readFileSync(path.join(target, "auth.json")), fs.readFileSync(path.join(source, "auth.json")));
    assert.deepEqual(fs.readFileSync(path.join(target, "models.json")), fs.readFileSync(path.join(source, "models.json")));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "settings.json"))).compaction,
      { enabled: true, reserveTokens: 40800, keepRecentTokens: 20000 });
    assert.equal(JSON.parse(fs.readFileSync(snapshot, "utf8")).migration.sourceFiles["auth.json"].sha256.length, 64);
    const rolled = run("pi-distribution", "rollback", "--snapshot", snapshot);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(fs.existsSync(target), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "config.json"))).agents[app].piDistribution, "external");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("TypeScript agent-config bridge preserves listing, fail-closed selection, and chats writes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-config-ts-"));
  try {
    const first = "cli_configA1";
    const second = "cli_configB2";
    const configFile = path.join(temp, "config.json");
    const initial = {
      version: 3,
      serverId: "server-agent-config",
      activeAgent: first,
      agents: {
        [first]: { runtime: "codex", model: "gpt-5.3-codex" },
        [second]: { runtime: "claude", model: "claude-sonnet-4-5" },
      },
    };
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LARKIN_CONFIG_DIR: temp },
    });

    const agents = run("agents");
    assert.equal(agents.status, 0, agents.stderr);
    assert.match(agents.stdout, /共 2 个 agent/);
    assert.match(agents.stdout, /cli_configA1 \[active\]/);
    assert.match(agents.stdout, /cli_configB2/);
    assert.match(agents.stdout, /入站=本次运行尚未收到消息验证/);

    const agentsJson = run("agents", "--json");
    assert.equal(agentsJson.status, 0, agentsJson.stderr);
    assert.deepEqual(JSON.parse(agentsJson.stdout), {
      version: 1,
      daemon: { owned: false, pid: null, started_at: null },
      agents: [
        {
          agent_id: first,
          name: first,
          runtime: "codex",
          model: "gpt-5.3-codex",
          document_comment: { event: "drive.notice.comment_add_v1", category: "not_requested", reason: "setup_required", requested_at: null,
            reply_scope: "docs:document.comment:create", reply_requested_at: null, event_verified_at: null, accepted_at: null, last_error: null, last_error_at: null,
            subscription: { mode: "none", status: "safe-default", source: "legacy-default", dimension: null } },
          ready: false,
          readiness: {
            daemon_owned: false,
            runtime_ready: false,
            channel_connected: false,
            channel_not_reconnecting: true,
          },
          channel: { connected_at: null, connected_via: null, inbound_verified_at: null },
        },
        {
          agent_id: second,
          name: second,
          runtime: "claude",
          model: "claude-sonnet-4-5",
          document_comment: { event: "drive.notice.comment_add_v1", category: "not_requested", reason: "setup_required", requested_at: null,
            reply_scope: "docs:document.comment:create", reply_requested_at: null, event_verified_at: null, accepted_at: null, last_error: null, last_error_at: null,
            subscription: { mode: "none", status: "safe-default", source: "legacy-default", dimension: null } },
          ready: false,
          readiness: {
            daemon_owned: false,
            runtime_ready: false,
            channel_connected: false,
            channel_not_reconnecting: true,
          },
          channel: { connected_at: null, connected_via: null, inbound_verified_at: null },
        },
      ],
    });

    const ambiguous = run("chats", "free", "oc_contract");
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /修改必须用 --agent/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), initial, "ambiguous mutation must not write config");

    const free = run("chats", "free", "oc_contract", "--agent", first);
    assert.equal(free.status, 0, free.stderr);
    assert.match(free.stdout, /免@已开/);
    let stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.version, 4);
    assert.deepEqual(stored.agents[first].chatMentionPolicies, { oc_contract: "free" });
    assert.deepEqual(stored.agents[second], initial.agents[second], "other Agent must remain equivalent as stored data");

    const strict = run("chats", "strict", "oc_contract", "--agent", first);
    assert.equal(strict.status, 0, strict.stderr);
    stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(stored.agents[first].chatMentionPolicies, { oc_contract: "require" });

    assert.equal(run("config", "mention", "global", "free").status, 0);
    const strictInherited = run("chats", "strict", "oc_global_free", "--agent", first);
    assert.equal(strictInherited.status, 0, strictInherited.stderr);
    assert.doesNotMatch(strictInherited.stdout, /本来就需@/);
    let resolved = JSON.parse(run("config", "show", "--agent", first, "--chat", "oc_global_free", "--json").stdout);
    assert.deepEqual(resolved.agents[0].mention.chat, { chatId: "oc_global_free", override: "require", effective: "require", source: "chat" });
    assert.equal(run("config", "mention", "chat", "oc_global_free", "inherit", "--agent", first).status, 0);
    resolved = JSON.parse(run("config", "show", "--agent", first, "--chat", "oc_global_free", "--json").stdout);
    assert.deepEqual(resolved.agents[0].mention.chat, { chatId: "oc_global_free", override: "inherit", effective: "free", source: "global" });
    assert.equal(run("chats", "free", "oc_global_free", "--agent", first).status, 0);
    stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[first].chatMentionPolicies.oc_global_free, "free");

    const beforeInvalid = fs.readFileSync(configFile, "utf8");
    const invalidRuntime = run("runtime", "not-a-runtime", "--agent", first);
    assert.equal(invalidRuntime.status, 1);
    assert.match(invalidRuntime.stderr, /不是合法 runtime/);
    assert.equal(fs.readFileSync(configFile, "utf8"), beforeInvalid, "invalid catalog choice must fail before write");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("compiled agents --json becomes ready only for the current daemon Runtime and channel", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agent-ready-cli-"));
  const agentId = "cli_readyJsonA1";
  const daemonEntry = path.join(temp, "app", "runtime-process.mjs");
  fs.mkdirSync(path.dirname(daemonEntry), { recursive: true });
  fs.writeFileSync(daemonEntry, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [daemonEntry], { stdio: "ignore" });
  try {
    let inspected;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      inspected = inspectProcess(child.pid);
      if (inspected?.ok) break;
      await Bun.sleep(20);
    }
    assert.equal(inspected?.ok, true, inspected?.reason);
    const startedAt = "2026-07-29T01:00:00.000Z";
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-ready-json", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "default" } },
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(temp, "daemon-status.json"), `${JSON.stringify({
      pid: child.pid,
      processStartToken: inspected.startToken,
      commandToken: "app/runtime-process.mjs",
      startedAt,
      agents: [agentId],
    })}\n`, { mode: 0o600 });
    const stateDir = path.join(temp, "state", "agents", agentId);
    fs.mkdirSync(stateDir, { recursive: true });
    const writeStatus = (value) => fs.writeFileSync(path.join(stateDir, "status.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    writeStatus({
      connectedAt: "2026-07-29T01:00:01.000Z",
      connectedVia: "channel",
      inboundVerifiedAt: "2026-07-29T01:00:02.000Z",
      reconnectingAt: null,
      runtimeReadiness: { state: "ready" },
    });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, "agents", ...args], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp },
    });
    const ready = run("--json");
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.daemon.owned, true);
    assert.equal(readyPayload.daemon.pid, child.pid);
    assert.equal(readyPayload.agents[0].ready, true);

    writeStatus({
      connectedAt: "2026-07-29T01:00:01.000Z",
      connectedVia: "channel",
      reconnectingAt: "2026-07-29T01:00:03.000Z",
      reconnectedAt: "2026-07-29T01:00:02.000Z",
      runtimeReadiness: { state: "ready" },
    });
    const reconnecting = JSON.parse(run("--json").stdout).agents[0];
    assert.equal(reconnecting.ready, false);
    assert.equal(reconnecting.readiness.channel_not_reconnecting, false);
    const reconnectingHuman = run();
    assert.equal(reconnectingHuman.status, 0, reconnectingHuman.stderr);
    assert.match(reconnectingHuman.stdout, /ws 重连中/);

    writeStatus({
      connectedAt: "2026-07-29T01:00:04.000Z",
      connectedVia: "channel",
      reconnectingAt: "2026-07-29T01:00:03.000Z",
      reconnectedAt: "2026-07-29T01:00:02.000Z",
      runtimeReadiness: { state: "ready" },
    });
    const reconnected = JSON.parse(run("--json").stdout).agents[0];
    assert.equal(reconnected.ready, true);
    assert.equal(reconnected.readiness.channel_not_reconnecting, true);
    const human = run();
    assert.equal(human.status, 0, human.stderr);
    assert.doesNotMatch(human.stdout, /ws 重连中/);

    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-ready-json", mentionPolicy: "require", activeAgent: null, agents: {},
    })}\n`, { mode: 0o600 });
    const empty = JSON.parse(run("--json").stdout);
    assert.deepEqual(empty.daemon, { owned: true, pid: child.pid, started_at: startedAt });
    assert.deepEqual(empty.agents, []);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("public config CLI uses LARKIN_AGENT_ID as its only Runtime marker", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-authority-"));
  const app = "cli_runtimeAuthorityA1";
  const file = path.join(temp, "config.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify({ version: 4, serverId: "server-authority", mentionPolicy: "require", activeAgent: app, agents: { [app]: { runtime: "pi", model: "default" } } })}\n`, { mode: 0o600 });
    const markerOnly = spawnSync(process.execPath, [PUBLIC_ENTRY, "config", "mention", "global", "free"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: app },
    });
    assert.equal(markerOnly.status, 0, markerOnly.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mentionPolicy, "free");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("public config operations reject extra positionals and inapplicable flags without changing config bytes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-config-exact-args-"));
  const app = "cli_exactArgsA1";
  const file = path.join(temp, "config.json");
  try {
    fs.writeFileSync(file, `${JSON.stringify({
      version: 4, serverId: "server-exact-args", mentionPolicy: "require", activeAgent: app,
      agents: { [app]: { runtime: "pi", model: "default" } },
    })}\n`, { mode: 0o600 });
    const before = fs.readFileSync(file);
    const invalidCases = [
      ["config", "show", "extra"],
      ["config", "show", "--model", "default"],
      ["config", "runtime", "pi", "extra"],
      ["config", "runtime", "pi", "--chat", "oc_irrelevant"],
      ["config", "model", "default", "extra"],
      ["config", "model", "default", "--chat", "oc_irrelevant"],
      ["config", "effort", "default", "extra"],
      ["config", "effort", "default", "--chat", "oc_irrelevant"],
      ["config", "mention", "global", "free", "extra"],
      ["config", "mention", "global", "free", "--agent", app],
      ["config", "mention", "global", "free", "--chat", "oc_irrelevant"],
      ["config", "mention", "agent", "free", "unexpected", "--agent", app],
      ["config", "mention", "agent", "free", "--chat", "oc_irrelevant"],
      ["config", "mention", "chat", "oc_exact", "free", "extra", "--agent", app],
      ["config", "mention", "chat", "oc_exact", "free", "--json"],
      ["config", "apply", "extra"],
      ["config", "apply", "--chat", "oc_irrelevant"],
    ];
    for (const args of invalidCases) {
      const rejected = spawnSync(process.execPath, [PUBLIC_ENTRY, ...args], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp },
      });
      assert.notEqual(rejected.status, 0, `${args.join(" ")} unexpectedly succeeded`);
      assert.match(rejected.stderr, /用法|不支持参数|只支持/);
      assert.deepEqual(fs.readFileSync(file), before, `${args.join(" ")} changed config bytes`);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("public config load failures do not disclose the absolute config path", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-missing-config-private-"));
  try {
    const result = spawnSync(process.execPath, [PUBLIC_ENTRY, "config", "show"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: temp },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Larkin 配置.*larkin setup/);
    assert.doesNotMatch(result.stderr, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stderr, /config\.json/);
    assert.doesNotMatch(result.stderr, /\n\s*at\s/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("user config CLI exposes precedence/source and separates saved runtime from explicit apply", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-user-config-cli-"));
  const app = "cli_userConfigA1";
  const other = "cli_userConfigB2";
  try {
    const bin = path.join(temp, "bin");
    fs.mkdirSync(bin);
    const fakeClaude = path.join(bin, "claude");
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env bun
let input="";process.stdin.on("data",c=>{input+=c;for(;;){const i=input.indexOf("\\n");if(i<0)break;const request=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(request.request?.subtype==="list_models")process.stdout.write(JSON.stringify({type:"control_response",response:{request_id:request.request_id,subtype:"success",response:{models:[{value:"default",displayName:"Default",resolvedModel:"claude-sonnet-5",supportsEffort:false,supportedEffortLevels:[]},{value:"sonnet",displayName:"Sonnet",resolvedModel:"claude-sonnet-5",supportsEffort:false,supportedEffortLevels:[]}]}}})+"\\n")}});`);
    fs.chmodSync(fakeClaude, 0o755);
    fs.mkdirSync(path.join(temp, "agents", app), { recursive: true });
    fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
      version: 3, serverId: "server-user-config", activeAgent: app,
      agents: {
        [app]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", noMentionChats: ["oc_legacy"] },
        [other]: { runtime: "pi", model: "default" },
      },
    })}\n`, { mode: 0o600 });
    const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp } });

    const beforeUnknownFlags = fs.readFileSync(path.join(temp, "config.json"));
    for (const args of [
      ["config", "mention", "global", "free", "--bogus", "value"],
      ["config", "mention", "agent", "free", "--agent", app, "--bogus"],
      ["config", "model", "default", "--agent", app, "--bogus", "value"],
    ]) {
      const rejected = spawnSync(process.execPath, [PUBLIC_ENTRY, ...args], {
        cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp },
      });
      assert.notEqual(rejected.status, 0, `${args.join(" ")} must reject unknown flags`);
      assert.match(rejected.stderr, /不支持参数|未知参数|--bogus/);
      assert.deepEqual(fs.readFileSync(path.join(temp, "config.json")), beforeUnknownFlags, "unknown flags must fail before config mutation");
    }

    const legacy = run("config", "show", "--agent", app, "--chat", "oc_legacy", "--json");
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.deepEqual(JSON.parse(legacy.stdout).agents[0].mention.chat, { chatId: "oc_legacy", override: "free", effective: "free", source: "chat" });

    assert.equal(run("config", "mention", "global", "free").status, 0);
    assert.equal(run("config", "mention", "agent", "require", "--agent", app).status, 0);
    assert.equal(run("config", "mention", "chat", "oc_legacy", "inherit", "--agent", app).status, 0);
    const runtimeCross = spawnSync(process.execPath, [ENTRY, "config", "mention", "agent", "free", "--agent", other], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp, LARKIN_AGENT_ID: app },
    });
    assert.equal(runtimeCross.status, 0, runtimeCross.stderr);
    const inherited = JSON.parse(run("config", "show", "--agent", app, "--chat", "oc_legacy", "--json").stdout);
    assert.deepEqual(inherited.agents[0].mention.chat, { chatId: "oc_legacy", override: "inherit", effective: "require", source: "agent" });

    const runtime = run("runtime", "claude", "--agent", app);
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.match(runtime.stdout, /saved_not_applied/);
    assert.doesNotMatch(runtime.stdout, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "mutation output must not expose the absolute config path");
    const stored = JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8"));
    assert.deepEqual({ runtime: stored.agents[app].runtime, model: stored.agents[app].model, effort: stored.agents[app].effort }, { runtime: "claude", model: "default", effort: undefined });
    assert.equal(stored.agents[other].mentionPolicy, "free");
    const nestedClear = spawnSync(process.execPath, [PUBLIC_ENTRY, "config", "effort", "clear", "--agent", app], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, LARKIN_CONFIG_DIR: temp },
    });
    assert.equal(nestedClear.status, 0, nestedClear.stderr);
    const pending = JSON.parse(run("config", "show", "--agent", app, "--json").stdout);
    assert.equal(pending.agents[0].apply.applyState, "pending");

    const apply = run("config", "apply", "--agent", app);
    assert.equal(apply.status, 1, "no daemon must not be reported as applied");
    assert.match(apply.stderr, /已保存但未应用/);
    const stillPending = JSON.parse(run("config", "show", "--agent", app, "--json").stdout);
    assert.equal(stillPending.agents[0].apply.applyState, "pending");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
