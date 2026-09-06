#!/usr/bin/env bun
/*
 * Synthetic, no-network comparison runner for the inbox-audit variants.
 * It deliberately exercises compiled Host / public CLI boundaries. Results are
 * observations, including expected defects; it does not assert a winner.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOTS = {
  main: path.resolve(HERE, "../.."),
};
const APP = "cli_inboxAuditA1";
const OTHER = "cli_inboxAuditB2";
const CHAT = "oc_AuditExperimentGroup1";
const THREAD = "omt_AuditExperimentThread1";
const INTERVAL = 15 * 60_000;
const CHILD_DEADLINE_MS = 750;

function parseArgs(argv) {
  const roots = { ...DEFAULT_ROOTS };
  let output = path.join(os.tmpdir(), "larkin-inbox-audit-ablation-results.json");
  let build = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output") output = path.resolve(argv[++index] || output);
    else if (flag === "--build") build = true;
    else if (flag === "--root") {
      const [name, value] = String(argv[++index] || "").split("=", 2);
      if (!name || !value) throw new Error("--root requires name=/absolute/path");
      roots[name] = path.resolve(value);
    } else if (flag === "--help") {
      console.log("bun test/experiments/inbox-audit-ablation.mjs --root 195=/path --root 187=/path --root combined=/path [--build] [--output /tmp/results.json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return { roots, output, build };
}

function exists(root, relative) { return fs.existsSync(path.join(root, relative)); }
function dist(root, relative) { return path.join(root, "dist", relative); }
function isolatedEnv(root, sandbox, extra = {}) {
  const home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    LARKIN_HOME: sandbox,
    LARKIN_CONFIG_DIR: sandbox,
    LARKSUITE_CLI_CONFIG_DIR: path.join(sandbox, "lark-cli-config"),
    NO_COLOR: "1",
    ...extra,
  };
}

function writeConfig(root, agents = [APP, OTHER]) {
  const entries = Object.fromEntries(agents.map((id) => [id, { runtime: "codex", model: "gpt-5.6-sol" }]));
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-inbox-audit-ablation", mentionPolicy: "require", activeAgent: APP, agents: entries,
  })}\n`, { mode: 0o600 });
}

function runPublic(root, sandbox, args, extraEnv = {}, timeout = 10_000) {
  const entry = dist(root, "app/cli.mjs");
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root, encoding: "utf8", timeout,
    env: isolatedEnv(root, sandbox, { LARKIN_BINARY_ENTRY_PATH: dist(root, "app/binary-entry.mjs"), ...extraEnv }),
  });
  return {
    status: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout || "", stderr: result.stderr || "",
  };
}

function runPublicWithDeadline(root, sandbox, args, extraEnv = {}, deadlineMs = CHILD_DEADLINE_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [dist(root, "app/cli.mjs"), ...args], {
      cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: isolatedEnv(root, sandbox, { LARKIN_BINARY_ENTRY_PATH: dist(root, "app/binary-entry.mjs"), ...extraEnv }),
    });
    let stdout = "";
    let stderr = "";
    let deadlineHit = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      deadlineHit = true;
      // The public router creates an internal CLI child. Kill the detached
      // process group so a FIFO reader cannot outlive this bounded probe.
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, deadlineMs);
    child.once("error", (error) => { clearTimeout(timer); resolve({ status: null, signal: null, deadlineHit, error: error.message, stdout, stderr }); });
    child.once("exit", (status, signal) => { clearTimeout(timer); resolve({ status, signal, deadlineHit, stdout, stderr }); });
  });
}

function jsonResult(result) {
  try { return { ok: result.status === 0, body: JSON.parse(result.stdout) }; }
  catch { return { ok: false, parseError: true, stderr: result.stderr.slice(0, 300), stdout: result.stdout.slice(0, 300) }; }
}

function auditCli(root, sandbox) {
  return jsonResult(runPublic(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP }));
}

function registryRows(count, version = 2, agentId = APP) {
  return {
    version,
    targets: Array.from({ length: count }, (_, index) => ({
      agent_id: agentId, target: `chat:oc_Audit${index}`, anchor: `om_audit_${index}`,
      observed_at: `2026-09-06T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      ...(version === 2 ? { status: "pending" } : {}),
    })),
  };
}

async function loadModules(root) {
  const token = `?ablation=${Date.now()}-${Math.random()}`;
  return {
    host: await import(`${pathToFileURL(dist(root, "feishu/host-shell.mjs")).href}${token}`),
    heartbeat: await import(`${pathToFileURL(dist(root, "agent/inbox-audit-heartbeat.mjs")).href}${token}`),
  };
}

function agent(root, id) {
  return {
    agentId: id, name: id, runtime: "codex", model: "gpt-5.6-sol", feishuAppId: id,
    feishuAppSecret: "synthetic-fixture-secret", feishuProfile: id, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", id), stateDir: path.join(root, "state", "agents", id),
    larkConfigDir: path.join(root, "lark-cli-config"),
  };
}

async function hostFixture(root, sandbox, modules) {
  const agents = [agent(sandbox, APP), agent(sandbox, OTHER)];
  const deliveries = [];
  const runtimeHost = {
    subscribe() { return () => {}; }, async start() {}, async stop() {}, async shutdown() {},
    async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); return { status: "accepted" }; },
  };
  const host = modules.host.createHostShell({
    env: isolatedEnv(root, sandbox, { LARKIN_SERVER_ID: "server-inbox-audit-ablation", LARKIN_AGENTS_CONFIG: JSON.stringify(agents) }),
    runtimeHost, eventSourceStartDelayMs: 60_000,
    logImpl() {},
    channelPackage: {
      createLarkChannel(options) {
        return {
          botIdentity: { openId: `ou_${options.appId}`, name: options.appId }, rawClient: null,
          dispatcher: { register() {} }, on() {}, async connect() {}, async disconnect() {},
          comments: { async resolveTarget() { return null; }, async fetch() { return null; } },
        };
      },
    },
    managedCliForAgent: () => ({ command: { command: "/synthetic/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_human", name: "Synthetic Human" }] } }), "");
      return {};
    },
  });
  return { host, agents, deliveries };
}

function seedOrdinaryInbox(sandbox) {
  const state = path.join(sandbox, "state", "agents", APP);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const inbox = path.join(state, "feishu-inbox.ndjson");
  const inboxState = path.join(state, "inbox-state.json");
  fs.writeFileSync(inbox, `${JSON.stringify({ message_id: "om_ordinary_sentinel", target: `chat:${CHAT}`, wake: true, content: "ordinary inbox sentinel" })}\n`, { mode: 0o600 });
  fs.writeFileSync(inboxState, `${JSON.stringify({
    version: 2,
    targets: { [`chat:${CHAT}`]: { latest_received_seq: 41, model_seen_seq: 41 } },
    messages: {}, drafts: {}, intents: {},
  })}\n`, { mode: 0o600 });
  return { inbox, inboxState, inboxBytes: fs.readFileSync(inbox, "utf8"), stateBytes: fs.readFileSync(inboxState, "utf8") };
}

function ordinaryInboxPreserved(sentinel) {
  return fs.readFileSync(sentinel.inbox, "utf8") === sentinel.inboxBytes
    && fs.readFileSync(sentinel.inboxState, "utf8") === sentinel.stateBytes;
}

async function withHostAuditTimers(root, sandbox, modules, action, fire = true) {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === INTERVAL) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object" && handle.delay === INTERVAL) return;
    return realClearTimeout(handle);
  };
  const fixture = await hostFixture(root, sandbox, modules);
  try {
    await fixture.host.start();
    const initialTimers = [...timers];
    const actionResult = await action(fixture);
    if (fire) for (const timer of initialTimers) await timer.callback();
    const reminders = fixture.deliveries.filter((row) => row.envelope?.kind === "reminder" || row.envelope?.target === "runtime:reminder");
    return { action: actionResult ?? null, initialTimers: initialTimers.map((timer) => timer.delay), capturedTimers: timers.length, appended: reminders.length, delivered: reminders.length, agents: reminders.map((row) => row.agentId) };
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    await fixture.host.shutdown("ablation host timer cleanup");
  }
}

async function concurrentNewAnchor(root, modules, enabled) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-audit-ablation-race-"));
  try {
    writeConfig(sandbox);
    if (enabled) runPublic(root, sandbox, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
    return await withHostAuditTimers(root, sandbox, modules, async (fixture) => {
      const base = {
        chat_id: CHAT, chat_type: "group", sender_id: "ou_race", content: "synthetic race", _mentioned_bot: true,
        _mention_all: false, _sender_is_bot: false, _scan_authority: true,
      };
      await fixture.host.ingest(APP, { ...base, thread_id: "omt_Race", message_id: "om_race_seed", event_id: "ev_race_seed" }, { wake: true });
      const observations = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const fresh = `om_race_new_${attempt}`;
        // Start the *public compiled* audit CLI and immediately race a newer
        // Host ingest on its same target. No helper is called to complete work.
        const cli = runPublicWithDeadline(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP });
        await fixture.host.ingest(APP, { ...base, thread_id: "omt_Race", message_id: fresh, event_id: `ev_race_new_${attempt}` }, { wake: true });
        const cliResult = await cli;
        const stored = JSON.parse(fs.readFileSync(path.join(sandbox, "inbox-audit.json"), "utf8"));
        const row = (stored.targets || []).find((candidate) => candidate.agent_id === APP && candidate.target === `thread:${CHAT}:omt_Race`);
        observations.push({ cliStatus: cliResult.status, deadlineHit: cliResult.deadlineHit, newestPresent: row?.anchor === fresh, status: row?.status ?? null });
      }
      const missing = observations.filter((row) => !row.newestPresent).length;
      return {
        attempts: 20, missingNewestAnchors: missing, cliDeadlineHits: observations.filter((row) => row.deadlineHit).length,
        completedNewest: observations.filter((row) => row.status === "completed").length,
        pendingNewest: observations.filter((row) => row.status === "pending").length,
        classification: missing ? "observed_loss_or_stale_anchor" : "uncontrolled_interleave_not_safety_evidence",
      };
    }, false);
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

async function hostIngestCases(root, sandbox, modules) {
  const base = {
    chat_id: CHAT, chat_type: "group", sender_id: "ou_human", content: "synthetic only", thread_id: null,
    _mentioned_bot: true, _mention_all: false, _sender_is_bot: false, _scan_authority: true,
  };
  return withHostAuditTimers(root, sandbox, modules, async (fixture) => {
    await fixture.host.ingest(APP, { ...base, message_id: "om_wake_false", event_id: "ev_wake_false" }, { wake: false });
    await fixture.host.ingest(APP, { ...base, message_id: "om_wake_true", event_id: "ev_wake_true", thread_id: THREAD }, { wake: true });
    await fixture.host.ingest(APP, { ...base, message_id: "om_wake_true_new", event_id: "ev_wake_true_new", thread_id: THREAD }, { wake: true });
    await fixture.host.ingest(APP, { ...base, message_id: "om_dm", event_id: "ev_dm", chat_type: "p2p" }, { wake: true });
    await fixture.host.ingest(APP, { ...base, message_id: "om_bot", event_id: "ev_bot", _sender_is_bot: true }, { wake: true });
    await fixture.host.ingest(APP, { ...base, message_id: "om_unauthorized", event_id: "ev_unauthorized", _scan_authority: false }, { wake: true });
    // Do not invoke audit here: the next real public CLI call is the deliberate
    // "caller failed before work" lifecycle probe below.
    // Do not invoke audit here: the next real public CLI call is the deliberate
    // "caller failed before work" lifecycle probe below.
    return { inboundDeliveries: fixture.deliveries.length, registry: registryState(sandbox) };
  }, false);
}

function registryState(sandbox) {
  const file = path.join(sandbox, "inbox-audit.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { version: parsed.version, pending: (parsed.targets || []).filter((row) => row.status === "pending").length, completed: (parsed.targets || []).filter((row) => row.status === "completed").length };
  } catch { return { missing: true }; }
}

async function ioBounds(root, sandbox, registryVersion) {
  const oversized = path.join(sandbox, "inbox-audit.json");
  fs.writeFileSync(oversized, `${JSON.stringify(registryRows(1, registryVersion))}\n`, { mode: 0o600 });
  const normal = await runPublicWithDeadline(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP });
  fs.writeFileSync(oversized, `${JSON.stringify(registryRows(10_000, registryVersion))}\n`, { mode: 0o600 });
  const oversize = await runPublicWithDeadline(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP });
  fs.rmSync(oversized, { force: true });
  fs.mkdirSync(oversized, { mode: 0o700 });
  const directory = await runPublicWithDeadline(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP });
  fs.rmSync(oversized, { recursive: true, force: true });
  const fifoResult = spawnSync("/usr/bin/mkfifo", [oversized], { encoding: "utf8" });
  const fifo = fifoResult.status === 0
    ? await runPublicWithDeadline(root, sandbox, ["inbox", "audit", "--json"], { LARKIN_AGENT_ID: APP })
    : { skipped: true, error: fifoResult.stderr || "mkfifo unavailable" };
  fs.rmSync(oversized, { force: true });
  return {
    normal: { deadlineHit: normal.deadlineHit, status: normal.status, signal: normal.signal },
    oversize: { deadlineHit: oversize.deadlineHit, status: oversize.status, signal: oversize.signal },
    directory: { deadlineHit: directory.deadlineHit, status: directory.status, signal: directory.signal },
    fifo: fifo.skipped ? fifo : { deadlineHit: fifo.deadlineHit, status: fifo.status, signal: fifo.signal },
  };
}

async function runVariant(name, root, shouldBuild) {
  if (!fs.existsSync(root)) return { name, skipped: "worktree missing" };
  const build = shouldBuild
    ? runPublicBuild(root)
    : { requested: false, status: exists(root, "dist/app/cli.mjs") ? 0 : null };
  if (build.status !== 0 || !exists(root, "dist/app/cli.mjs")) return { name, skipped: "compiled dist missing or build failed", build };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-${name}-`));
  try {
    writeConfig(sandbox);
    const modules = await loadModules(root);
    const configDefault = runPublic(root, sandbox, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
    const configured = jsonResult(configDefault);
    const configBytes = fs.existsSync(path.join(sandbox, "config.json")) ? JSON.parse(fs.readFileSync(path.join(sandbox, "config.json"), "utf8")) : null;
    const configurable = Boolean(configBytes?.inboxAudit?.enabled);
    const host = await hostIngestCases(root, sandbox, modules);
    const afterHost = registryState(sandbox);
    const ordinaryInbox = seedOrdinaryInbox(sandbox);
    const firstRead = auditCli(root, sandbox);
    const afterFirstRead = registryState(sandbox);
    const secondRead = auditCli(root, sandbox);
    const ordinaryInboxAfterCli = ordinaryInboxPreserved(ordinaryInbox);
    // This second Host instance owns its production heartbeat and reads the
    // persisted registry/config itself; no injected shouldDispatch is used.
    const heartbeatAfterRead = await withHostAuditTimers(root, sandbox, modules, async () => {}, true);
    fs.writeFileSync(path.join(sandbox, "inbox-audit.json"), `${JSON.stringify({ version: 1, targets: registryRows(1, 1).targets })}\n`, { mode: 0o600 });
    const legacyV1 = auditCli(root, sandbox);
    const registryVersion = configurable ? 2 : 1;
    fs.writeFileSync(path.join(sandbox, "inbox-audit.json"), `${JSON.stringify(registryRows(100, registryVersion))}\n`, { mode: 0o600 });
    const capacity = auditCli(root, sandbox);
    const io = await ioBounds(root, sandbox, registryVersion);
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-empty-${name}-`));
    writeConfig(emptyRoot);
    if (configurable) runPublic(root, emptyRoot, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
    const emptyTick = await withHostAuditTimers(root, emptyRoot, modules, async () => {}, true);
    fs.rmSync(emptyRoot, { recursive: true, force: true });
    const positiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-positive-${name}-`));
    writeConfig(positiveRoot);
    if (configurable) runPublic(root, positiveRoot, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
    await hostIngestCases(root, positiveRoot, modules);
    const enabledPositive = await withHostAuditTimers(root, positiveRoot, modules, async () => {}, true);
    fs.rmSync(positiveRoot, { recursive: true, force: true });
    const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-default-${name}-`));
    writeConfig(defaultRoot);
    await hostIngestCases(root, defaultRoot, modules);
    const defaultTick = await withHostAuditTimers(root, defaultRoot, modules, async () => {}, true);
    fs.rmSync(defaultRoot, { recursive: true, force: true });
    const disabledRoot = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-disabled-${name}-`));
    writeConfig(disabledRoot);
    let disableCommand = { status: null, stderr: "not supported by this treatment" };
    let disabledTick = { unavailable: true };
    if (configurable) {
      runPublic(root, disabledRoot, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
      await hostIngestCases(root, disabledRoot, modules);
      disableCommand = runPublic(root, disabledRoot, ["config", "inbox-audit", "global", "off", "--interval", "15m"]);
      disabledTick = await withHostAuditTimers(root, disabledRoot, modules, async () => {}, true);
    }
    fs.rmSync(disabledRoot, { recursive: true, force: true });
    let agentOverride = { unavailable: true };
    if (configurable) {
      const overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-audit-ablation-override-${name}-`));
      writeConfig(overrideRoot);
      runPublic(root, overrideRoot, ["config", "inbox-audit", "global", "on", "--interval", "15m"]);
      await hostIngestCases(root, overrideRoot, modules);
      const off = runPublic(root, overrideRoot, ["config", "inbox-audit", "agent", "off", "--agent", APP, "--interval", "15m"]);
      const offTick = await withHostAuditTimers(root, overrideRoot, modules, async () => {}, true);
      const inherit = runPublic(root, overrideRoot, ["config", "inbox-audit", "agent", "inherit", "--agent", APP, "--interval", "inherit"]);
      const inheritTick = await withHostAuditTimers(root, overrideRoot, modules, async () => {}, true);
      agentOverride = { offStatus: off.status, offTick, inheritStatus: inherit.status, inheritTick };
      fs.rmSync(overrideRoot, { recursive: true, force: true });
    }
    const race = await concurrentNewAnchor(root, modules, configurable);
    const invalidReasons = [];
    if (io.normal.status !== 0 || io.normal.deadlineHit) invalidReasons.push("normal_public_audit_cli_failed");
    if (!enabledPositive.agents.includes(APP) || enabledPositive.delivered < 1) invalidReasons.push("positive_host_timer_did_not_deliver_eligible_agent");
    if (!ordinaryInboxAfterCli) invalidReasons.push("audit_cli_changed_ordinary_inbox_or_model_seen_sentinel");
    if (configurable && configDefault.status !== 0) invalidReasons.push("supported_enabled_config_command_failed");
    return {
      name, root, revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
      provenance: {
        build,
        trackedSourceClean: spawnSync("git", ["diff", "--quiet"], { cwd: root }).status === 0
          && spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status === 0,
      },
      config: { supportsConfig: configurable, enabledTreatment: true, enableCommand: { status: configDefault.status, stderr: configDefault.stderr.slice(0, 160) }, enableResult: configured },
      host,
      lifecycle: { afterHost, firstRead, afterFirstRead, secondRead, heartbeatAfterRead, ordinaryInboxPreserved: ordinaryInboxAfterCli },
      timer: { beforeReadHeartbeat: enabledPositive, defaultTick, emptyTick, disabledTick, agentOverride, disableCommand: { status: disableCommand.status, stderr: disableCommand.stderr.slice(0, 160) } },
      legacyV1, capacity, io, race,
      validity: { valid: invalidReasons.length === 0, invalidReasons, timestampsExcludedFromMetrics: true },
    };
  } catch (error) { return { name, root, failure: error instanceof Error ? error.stack : String(error) }; }
  finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

function runPublicBuild(root) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-audit-ablation-build-home-"));
  try {
    const result = spawnSync("bun", ["run", "build"], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, LARKIN_HOME: home, LARKIN_CONFIG_DIR: home },
    });
    return { requested: true, command: "bun run build", status: result.status, timedOut: result.error?.code === "ETIMEDOUT", stderr: (result.stderr || "").slice(-400) };
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const { roots, output, build } = parseArgs(process.argv.slice(2));
const results = {
  schema: "larkin.inbox-audit-ablation.v1", generatedAt: new Date().toISOString(),
  runner: { digest: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), buildRequested: build },
  contract: { synthetic: true, noNetwork: true, intervalMs: INTERVAL, childDeadlineMs: CHILD_DEADLINE_MS, metrics: ["append", "deliver", "returnedRows", "pending"], timestampsExcludedFromMetrics: true },
  variants: [],
};
for (const [name, root] of Object.entries(roots)) results.variants.push(await runVariant(name, root, build));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output, variants: results.variants.map((item) => ({ name: item.name, revision: item.revision, skipped: item.skipped, failure: item.failure })) }, null, 2));
if (results.variants.some((item) => item.failure || item.validity?.valid === false)) process.exitCode = 1;
