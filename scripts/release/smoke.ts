#!/usr/bin/env bun
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
// Release smoke runs only after `bun run build`; exercising dist keeps the
// same compiled module graph used to construct the standalone.
// @ts-expect-error dist is generated and intentionally has no declaration file.
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
// @ts-expect-error dist is generated and intentionally has no declaration file.
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
// @ts-expect-error dist is generated and intentionally has no declaration file.
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import type { RuntimeInput, RuntimeSession } from "../../src/runtime/runtime-contracts.js";

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
    const upgradeFixtureFile = path.resolve(import.meta.dirname, "../../test/fixtures/runtime-upgrade/v0.3.3-active-thread.json");
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
    const upgradeStore = createAgentStateStore(larkinHome, upgradeFixture.agent_id);
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
