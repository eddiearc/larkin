#!/usr/bin/env bun
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  selectReleaseArtifact,
  verifyReleaseArtifact,
  verifyReleaseNotices,
  type ReleaseManifest,
} from "../../src/platform/release-artifacts.js";
import {
  prepareRestrictedSmokePath,
  smokeArtifactEnvironment,
  smokeTerminationPlan,
} from "./smoke-support.js";
import type { RuntimeInput, RuntimeSession } from "../../src/runtime/runtime-contracts.js";

type CreateAgentStateStore = typeof import("../../src/agent/agent-state-store.js")["createAgentStateStore"];
type ContextPromptBuilderConstructor = typeof import("../../src/agent/context-prompt.js")["ContextPromptBuilder"];
type CreateRuntimeHost = typeof import("../../src/runtime/runtime-host.js")["createRuntimeHost"];

const RELEASE_CANDIDATE_ROOT_ENV = "LARKIN_RELEASE_CANDIDATE_ROOT";
const RUNTIME_UPGRADE_CANDIDATE_FILES = Object.freeze({
  package: "package.json",
  fixture: "test/fixtures/runtime-upgrade/v0.3.3-active-thread.json",
  agentStateStore: "dist/agent/agent-state-store.mjs",
  contextPrompt: "dist/agent/context-prompt.mjs",
  runtimeHost: "dist/runtime/runtime-host.mjs",
});

export interface CandidateRuntimeUpgradeModules {
  candidateRoot: string;
  upgradeFixtureFile: string;
  moduleOrigins: Readonly<{
    agentStateStore: string;
    contextPrompt: string;
    runtimeHost: string;
  }>;
  createAgentStateStore: CreateAgentStateStore;
  ContextPromptBuilder: ContextPromptBuilderConstructor;
  createRuntimeHost: CreateRuntimeHost;
}

function canonicalDirectory(directory: string, label: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new Error(`${label} is unavailable: ${directory}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  return fs.realpathSync.native(directory);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function candidateRegularFile(candidateRoot: string, relativeFile: string): string {
  const unresolved = path.resolve(candidateRoot, relativeFile);
  if (!isWithin(candidateRoot, unresolved) || unresolved === candidateRoot) {
    throw new Error(`release smoke candidate path escaped its root: ${relativeFile}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(unresolved);
  } catch {
    throw new Error(`release smoke candidate file is missing: ${relativeFile}`);
  }
  if (!stat.isFile()) throw new Error(`release smoke candidate path is not a regular file: ${relativeFile}`);
  const canonicalFile = fs.realpathSync.native(unresolved);
  if (!isWithin(candidateRoot, canonicalFile)) {
    throw new Error(`release smoke candidate file escaped its root: ${relativeFile}`);
  }
  return canonicalFile;
}

function releaseCandidateRoot(): string {
  const workingRoot = canonicalDirectory(process.cwd(), "release smoke working directory");
  const configuredRoot = process.env[RELEASE_CANDIDATE_ROOT_ENV];
  if (configuredRoot === undefined) return workingRoot;
  if (!configuredRoot || /[\0\r\n]/.test(configuredRoot) || !path.isAbsolute(configuredRoot)) {
    throw new Error(`${RELEASE_CANDIDATE_ROOT_ENV} must be one absolute directory path`);
  }
  const candidateRoot = canonicalDirectory(configuredRoot, `${RELEASE_CANDIDATE_ROOT_ENV} candidate root`);
  if (path.relative(workingRoot, candidateRoot) !== "") {
    throw new Error(`${RELEASE_CANDIDATE_ROOT_ENV} does not match the release smoke working directory`);
  }
  return candidateRoot;
}

// Recovery runs may execute this script from a newer release-tooling checkout.
// The immutable candidate working directory is the sole authority for Runtime
// modules and fixtures; there is intentionally no import.meta.dirname fallback.
export async function loadCandidateRuntimeUpgradeModules(expectedVersion: string): Promise<CandidateRuntimeUpgradeModules> {
  const candidateRoot = releaseCandidateRoot();
  const packageFile = candidateRegularFile(candidateRoot, RUNTIME_UPGRADE_CANDIDATE_FILES.package);
  const upgradeFixtureFile = candidateRegularFile(candidateRoot, RUNTIME_UPGRADE_CANDIDATE_FILES.fixture);
  const agentStateStoreFile = candidateRegularFile(candidateRoot, RUNTIME_UPGRADE_CANDIDATE_FILES.agentStateStore);
  const contextPromptFile = candidateRegularFile(candidateRoot, RUNTIME_UPGRADE_CANDIDATE_FILES.contextPrompt);
  const runtimeHostFile = candidateRegularFile(candidateRoot, RUNTIME_UPGRADE_CANDIDATE_FILES.runtimeHost);

  let candidatePackage: { name?: unknown; version?: unknown };
  try {
    candidatePackage = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    throw new Error("release smoke candidate package.json is invalid");
  }
  if (candidatePackage.name !== "larkin" || candidatePackage.version !== expectedVersion) {
    throw new Error(`release smoke candidate package identity does not match manifest version ${expectedVersion}`);
  }

  // Every expected path is checked above before any candidate code is loaded.
  const moduleOrigins = Object.freeze({
    agentStateStore: pathToFileURL(agentStateStoreFile).href,
    contextPrompt: pathToFileURL(contextPromptFile).href,
    runtimeHost: pathToFileURL(runtimeHostFile).href,
  });
  const [agentStateStoreModule, contextPromptModule, runtimeHostModule] = await Promise.all([
    import(moduleOrigins.agentStateStore),
    import(moduleOrigins.contextPrompt),
    import(moduleOrigins.runtimeHost),
  ]);
  if (typeof agentStateStoreModule.createAgentStateStore !== "function"
    || typeof contextPromptModule.ContextPromptBuilder !== "function"
    || typeof runtimeHostModule.createRuntimeHost !== "function") {
    throw new Error("release smoke candidate Runtime modules do not expose the expected API");
  }
  return {
    candidateRoot,
    upgradeFixtureFile,
    moduleOrigins,
    createAgentStateStore: agentStateStoreModule.createAgentStateStore as CreateAgentStateStore,
    ContextPromptBuilder: contextPromptModule.ContextPromptBuilder as ContextPromptBuilderConstructor,
    createRuntimeHost: runtimeHostModule.createRuntimeHost as CreateRuntimeHost,
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a dashboard smoke port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function checkedArtifact(artifact: string, argv: string[], env: NodeJS.ProcessEnv, label: string): string {
  const result = spawnSync(artifact, argv, { encoding: "utf8", env, timeout: 15_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message || `exit ${result.status}`}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  }
  return result.stdout;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { child.off("exit", exited); resolve(false); }, timeoutMs);
    const exited = (): void => { clearTimeout(timer); resolve(true); };
    child.once("exit", exited);
  });
}

async function stop(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid) throw new Error("release smoke dashboard child has no pid");
  const plan = smokeTerminationPlan(platform, child.pid);
  if (plan.kind === "windows-tree") {
    const killer = spawn(plan.command, plan.args, { stdio: ["ignore", "ignore", "pipe"] });
    let killerError: Error | null = null;
    let killerStderr = "";
    killer.once("error", (error) => { killerError = error; });
    killer.stderr?.on("data", (chunk) => { killerStderr = `${killerStderr}${chunk}`.slice(-16_384); });
    if (!await waitForExit(child, 10_000)) {
      killer.kill();
      throw new Error(`failed to terminate Windows dashboard process tree${killerError ? `: ${killerError.message}` : ""}\n${killerStderr}`);
    }
    if (!await waitForExit(killer, 1_000)) killer.kill();
    return;
  }

  child.kill(plan.graceful);
  if (await waitForExit(child, 5_000)) return;
  child.kill(plan.force);
  if (!await waitForExit(child, 5_000)) throw new Error("dashboard process did not exit after SIGKILL");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== "--release-dir" || !argv[1] || argv[1].startsWith("--")) {
    throw new Error("usage: bun run release:smoke -- --release-dir <directory>");
  }

  const releaseDir = path.resolve(argv[1]);
  const manifestFile = path.join(releaseDir, "release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as ReleaseManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error("unsupported release manifest");
  const platform = os.platform();
  const arch = os.arch();
  const record = selectReleaseArtifact(manifest, platform, arch);
  verifyReleaseNotices(releaseDir, manifest);
  const artifact = verifyReleaseArtifact(releaseDir, record);
  const {
    createAgentStateStore,
    ContextPromptBuilder,
    createRuntimeHost,
    upgradeFixtureFile,
  } = await loadCandidateRuntimeUpgradeModules(manifest.version);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-smoke-"));
  const home = path.join(temporaryRoot, "home");
  const larkinHome = path.join(home, ".larkin");
  const restrictedBin = path.join(temporaryRoot, "bin");
  let dashboard: ChildProcess | null = null;
  let stdout = "";
  let stderr = "";
  try {
    fs.mkdirSync(larkinHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(restrictedBin, { mode: 0o700 });
    const restrictedPath = prepareRestrictedSmokePath(platform, restrictedBin);
    const artifactEnv = smokeArtifactEnvironment({ platform, home, larkinHome, restrictedPath });
    const version = checkedArtifact(artifact, ["--version"], artifactEnv, "artifact version").trim();
    if (version !== `larkin ${manifest.version}`) throw new Error(`unexpected artifact version: ${version}`);
    const help = checkedArtifact(artifact, ["--help"], artifactEnv, "artifact help");
    if (!help.includes("Usage: larkin <command>")) throw new Error("artifact help is missing the public usage contract");

    // Release smoke must cross a real upgrade boundary, not only boot a clean
    // temporary home. This source-tag API capture is explicitly provenance-
    // bounded in the fixture; the candidate Runtime must migrate and replay its
    // same-home active targetless ledger, then the standalone must read that
    // upgraded Inbox/ledger state without an extra mutation.
    const upgradeFixture = JSON.parse(fs.readFileSync(upgradeFixtureFile, "utf8")) as {
      provenance: { release_tag: string; claim_boundary: string };
      agent_id: string;
      files: Record<string, unknown>;
    };
    if (upgradeFixture.provenance.release_tag !== "v0.3.3" || !/not a customer home/i.test(upgradeFixture.provenance.claim_boundary)) {
      throw new Error("runtime upgrade smoke fixture provenance is missing or overstated");
    }
    const upgradeStateDir = path.join(larkinHome, "state", "agents", upgradeFixture.agent_id);
    fs.mkdirSync(upgradeStateDir, { recursive: true, mode: 0o700 });
    const inboxRows = upgradeFixture.files["feishu-inbox.ndjson"] as unknown[];
    const inboxBytes = `${inboxRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const inboxFile = path.join(upgradeStateDir, "feishu-inbox.ndjson");
    const inboxStateFile = path.join(upgradeStateDir, "inbox-state.json");
    const deliveryFile = path.join(upgradeStateDir, "runtime-deliveries.json");
    fs.writeFileSync(inboxFile, inboxBytes, { mode: 0o600 });
    fs.writeFileSync(inboxStateFile, `${JSON.stringify(upgradeFixture.files["inbox-state.json"], null, 2)}\n`, { mode: 0o600 });
    const deliveryBytes = `${JSON.stringify(upgradeFixture.files["runtime-deliveries.json"], null, 2)}\n`;
    fs.writeFileSync(deliveryFile, deliveryBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(larkinHome, "config.json"), `${JSON.stringify({
      version: 4, serverId: "release-smoke-upgrade", mentionPolicy: "require", activeAgent: upgradeFixture.agent_id,
      agents: { [upgradeFixture.agent_id]: { runtime: "codex", model: "captured" } },
    })}\n`, { mode: 0o600 });
    const submittedInputs: RuntimeInput[] = [];
    const runtimeSession: RuntimeSession = {
      sessionId: "release-smoke-upgrade-session",
      async prompt(input) { submittedInputs.push(structuredClone(input)); return { status: "accepted", inputId: input.inputId }; },
      async busyInput(input) { submittedInputs.push(structuredClone(input)); return { status: "accepted", inputId: input.inputId }; },
      async cancel() {}, async close() {}, subscribe() { return () => {}; },
    };
    const upgradeStore = createAgentStateStore(larkinHome, upgradeFixture.agent_id, {
      inspectProcess: (pid: number) => ({ ok: true, dead: false, startToken: `release-upgrade-${pid}` }),
    });
    const runtimeHost = createRuntimeHost({
      adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return runtimeSession; } }),
      promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => upgradeStore, assertOfficialCliReady: () => {},
    });
    fs.mkdirSync(path.join(larkinHome, "agents", upgradeFixture.agent_id), { recursive: true });
    try {
      await runtimeHost.start([{ agentId: upgradeFixture.agent_id, name: upgradeFixture.agent_id,
        runtime: "codex", model: "captured", workspaceDir: path.join(larkinHome, "agents", upgradeFixture.agent_id),
        stateDir: upgradeStateDir }]);
    } finally {
      await runtimeHost.shutdown("release smoke upgrade replay complete");
    }
    const expectedTarget = "thread:oc_issue124_upgrade:omt_issue124_upgrade";
    const expectedNotice = `The Larkin Inbox changed for ${expectedTarget} (1 pending message). Poll that target at the next safe boundary before any target-local side effect.`;
    if (submittedInputs.length !== 1 || submittedInputs[0]?.text !== expectedNotice) {
      throw new Error(`candidate Runtime failed to rebuild the exact canonical v0.3.3 thread notice (inputs=${submittedInputs.length}, actual=${JSON.stringify(submittedInputs[0]?.text || null)})`);
    }
    const upgradedDelivery = JSON.parse(fs.readFileSync(deliveryFile, "utf8"));
    if (upgradedDelivery.records?.[0]?.status !== "accepted" || upgradedDelivery.records?.[0]?.target !== expectedTarget
      || upgradedDelivery.records?.[0]?.input?.text !== expectedNotice) {
      throw new Error("candidate Runtime failed to persist the rebuilt v0.3.3 active delivery");
    }
    const upgradedDeliveryBytes = fs.readFileSync(deliveryFile, "utf8");
    if (upgradedDeliveryBytes === deliveryBytes) throw new Error("candidate Runtime did not migrate the active targetless v0.3.3 ledger");

    const upgradeCheck = JSON.parse(checkedArtifact(artifact,
      ["__internal", "agent-cli", "inbox", "check", "--target", expectedTarget, "--json"],
      { ...artifactEnv, LARKIN_AGENT_ID: upgradeFixture.agent_id }, "artifact v0.3.3 same-home upgrade state"));
    if (upgradeCheck.pending_total !== 1 || upgradeCheck.targets?.[0]?.target !== expectedTarget) {
      throw new Error("artifact failed to resolve the captured v0.3.3 canonical thread target");
    }
    if (fs.readFileSync(inboxFile, "utf8") !== inboxBytes || fs.readFileSync(deliveryFile, "utf8") !== upgradedDeliveryBytes) {
      throw new Error("read-only artifact upgrade check mutated candidate Runtime state");
    }

    const port = await freePort();
    dashboard = spawn(artifact, ["__internal", "dashboard", "--port", String(port)], {
      env: artifactEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    dashboard.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16_384); });
    dashboard.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15_000;
    let rootResponse: Response | null = null;
    while (Date.now() < deadline) {
      if (dashboard.exitCode !== null || dashboard.signalCode !== null) {
        throw new Error(`embedded Dashboard exited before readiness\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      try {
        const response = await fetch(url);
        if (response.status === 200) { rootResponse = response; break; }
      } catch { /* dashboard is still starting */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (!rootResponse) throw new Error(`embedded Dashboard did not return HTTP 200\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    const html = await rootResponse.text();
    if (!html.includes("dashboard-assets/dashboard.js")) throw new Error("Dashboard HTML does not reference the embedded client asset");
    const client = await fetch(`${url}/dashboard-assets/dashboard.js`);
    if (client.status !== 200 || (await client.arrayBuffer()).byteLength < 100_000) {
      throw new Error("embedded Dashboard client asset failed its HTTP smoke check");
    }

    process.stdout.write(`${JSON.stringify({ ok: true, platform, arch, artifact: record.file, version: manifest.version,
      legacyUpgradeState: "v0.3.3 active Runtime ledger replayed", dashboard: "HTTP 200" })}\n`);
  } finally {
    try {
      if (dashboard) await stop(dashboard, platform);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();
