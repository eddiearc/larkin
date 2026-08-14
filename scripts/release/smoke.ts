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
    const killed = spawnSync(plan.command, plan.args, { encoding: "utf8", timeout: 10_000 });
    if ((killed.error || killed.status !== 0) && child.exitCode === null && child.signalCode === null) {
      throw new Error(`failed to terminate Windows dashboard process tree: ${killed.error?.message || `exit ${killed.status}`}\n${killed.stderr || ""}`);
    }
    if (!await waitForExit(child, 5_000)) throw new Error("Windows dashboard process tree did not exit after taskkill");
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

    process.stdout.write(`${JSON.stringify({ ok: true, platform, arch, artifact: record.file, version: manifest.version, dashboard: "HTTP 200" })}\n`);
  } finally {
    try {
      if (dashboard) await stop(dashboard, platform);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();
