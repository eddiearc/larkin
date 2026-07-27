import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRY = path.join(ROOT, "dist/app/dashboard.mjs");
const SOURCE = path.join(ROOT, "src/app/dashboard.ts");
const BUILT = path.join(ROOT, "dist/app/dashboard.mjs");
const APP = "cli_dashboardA1";
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("dashboard is strict TypeScript compiled to a localhost-only direct entry", () => {
  assert.equal(fs.existsSync(SOURCE), true);
  assert.equal(fs.existsSync(BUILT), true);
  const entry = fs.readFileSync(ENTRY, "utf8");
  assert.match(entry, /createServer|server\.listen|collectStatus|process\.on/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
  const source = fs.readFileSync(SOURCE, "utf8");
  assert.match(source, /const listenHost = "127\.0\.0\.1"/);
  assert.doesNotMatch(source, /@ts-nocheck|Record<string,\s*any>/);
});

test("dashboard is layered: React workbench, shell template, filesystem-only view model, thin server", () => {
  const server = fs.readFileSync(SOURCE, "utf8");
  const template = fs.readFileSync(path.join(ROOT, "src/dashboard/dashboard-template.ts"), "utf8");
  const viewModel = fs.readFileSync(path.join(ROOT, "src/dashboard/dashboard-view-model.ts"), "utf8");
  const workbench = fs.readFileSync(path.join(ROOT, "src/dashboard/web/app.tsx"), "utf8");
  const state = fs.readFileSync(path.join(ROOT, "src/dashboard/web/dashboard-state.ts"), "utf8");
  const styles = fs.readFileSync(path.join(ROOT, "src/dashboard/web/styles.css"), "utf8");
  assert.doesNotMatch(template, /\bimport\b(?!\s*\()/, "template must not import runtime modules");
  assert.match(template, /export function renderDashboardHtml\(/);
  assert.match(template, /dashboard-assets\/dashboard\.css/);
  assert.match(template, /dashboard-assets\/dashboard\.js/);
  assert.match(workbench, /visibleModels/);
  assert.match(workbench, /model === "default"/);
  assert.match(workbench, /GroupPolicyTable/);
  assert.doesNotMatch(workbench, /覆盖链|effective=|source=/, "implementation precedence details stay out of the user-facing workbench");
  assert.match(workbench, /\/api\/config\/apply/);
  assert.match(workbench, /GlobalSettingsSheet/);
  assert.match(workbench, /role="tablist"/);
  assert.match(state, /overview.*conversation.*configuration.*reminders.*workspace.*logs/);
  assert.match(styles, /body \{[^}]*overflow-x: (?:hidden|clip)/, "dashboard must not expose page-level horizontal scrolling");
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.doesNotMatch(template, /function renderAgents|class="grid"/);
  assert.doesNotMatch(viewModel, /node:http|createServer|\.listen\(/);
  assert.match(viewModel, /export (?:async )?function collectStatus\(/);
  assert.doesNotMatch(server, /GOOGLE_FONTS_URL|collectAgentStatus|collectRuntimeUsage/);
  assert.ok(server.split("\n").length < 200, "dashboard server layer should stay thin");
});

test("real dashboard serves status, workspace, assets, and cleans owner state on SIGINT", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-http-"));
  const port = await freePort();
  const workspace = path.join(root, "agents", APP);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), "dashboard contract\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3,
    serverId: "server-dashboard-http",
    activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "gpt-5.6-sol" } },
  }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [ENTRY, "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, HOME: path.join(root, "home"), LARKIN_CONFIG_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const statusFile = path.join(root, "dashboard-status.json");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(statusFile) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(statusFile), true, output);
    const owner = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.equal(owner.pid, child.pid);
    assert.equal(owner.port, port);
    assert.equal(fs.statSync(statusFile).mode & 0o777, 0o600);

    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /LARKIN · Dashboard/);

    const status = await fetch(`${base}/api/status`).then((response) => response.json());
    assert.match(status.version, new RegExp(`^${PACKAGE_VERSION.replace(/\./g, "\\.")}\\+[a-f0-9]{12}$`));
    assert.equal(status.packageVersion, PACKAGE_VERSION);
    assert.match(status.buildFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(status.agents.map((agent) => agent.agentId), [APP]);
    assert.equal(status.agents[0].inboundVerifiedInThisRun, false);
    const directory = await fetch(`${base}/api/workspace?agent=${APP}&path=`).then((response) => response.json());
    assert.equal(directory.kind, "directory");
    assert.equal(directory.entries.some((entry) => entry.name === "MEMORY.md"), true);
    assert.equal((await fetch(`${base}/api/workspace?agent=${APP}&path=..%2Fconfig.json`)).status, 400);
    assert.equal((await fetch(`${base}/assets/larkin-mark.svg`)).status, 200);
    const css = await fetch(`${base}/dashboard-assets/dashboard.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);
    const javascript = await fetch(`${base}/dashboard-assets/dashboard.js`);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${base}/missing`)).status, 404);

    child.kill("SIGINT");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(fs.existsSync(statusFile), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
