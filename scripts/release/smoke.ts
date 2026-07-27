#!/usr/bin/env bun
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  selectReleaseArtifact,
  verifyReleaseArtifact,
  type ReleaseManifest,
} from "../../src/platform/release-artifacts.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--release-dir" || !args[1] || args[1].startsWith("--")) {
  throw new Error("usage: bun run release:smoke -- --release-dir <directory>");
}

const releaseDir = path.resolve(args[1]);
const manifestFile = path.join(releaseDir, "release-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as ReleaseManifest;
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) throw new Error("unsupported release manifest");
const platform = os.platform();
const arch = os.arch();
const record = selectReleaseArtifact(manifest, platform, arch);
const artifact = verifyReleaseArtifact(releaseDir, record);

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

function checkedArtifact(argv: string[], env: NodeJS.ProcessEnv, label: string): string {
  const result = spawnSync(artifact, argv, { encoding: "utf8", env, timeout: 15_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message || `exit ${result.status}`}\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  }
  return result.stdout;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

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
  const systemPs = ["/bin/ps", "/usr/bin/ps"].find((candidate) => fs.existsSync(candidate));
  if (!systemPs) throw new Error("release smoke requires the platform ps executable");
  fs.symlinkSync(systemPs, path.join(restrictedBin, "ps"));
  const artifactEnv: NodeJS.ProcessEnv = {
    HOME: home,
    LARKIN_HOME: larkinHome,
    LARKIN_CONFIG_DIR: larkinHome,
    PATH: restrictedBin,
    TMPDIR: os.tmpdir(),
    NO_COLOR: "1",
  };
  const version = checkedArtifact(["--version"], artifactEnv, "artifact version").trim();
  if (version !== `larkin ${manifest.version}`) throw new Error(`unexpected artifact version: ${version}`);
  const help = checkedArtifact(["--help"], artifactEnv, "artifact help");
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
  if (dashboard) await stop(dashboard);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
