import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN = process.env.LARKIN_RUN_DASHBOARD_BROWSER_TEST === "1";
const CHROME = process.env.LARKIN_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP = "cli_InboxAuditBrowserA1";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitReady(file, child, output) {
  const deadline = Date.now() + 8_000;
  while (!fs.existsSync(file) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(file), true, output());
}

test.skipIf(!RUN)("real Chromium saves Inbox audit settings through the local Dashboard", { timeout: 30_000 }, async () => {
  assert.equal(fs.existsSync(CHROME), true, `Chromium executable missing: ${CHROME}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-browser-"));
  const evidence = process.env.LARKIN_DASHBOARD_BROWSER_EVIDENCE_DIR || path.join(ROOT, "artifacts", "dashboard-inbox-audit-browser");
  fs.mkdirSync(evidence, { recursive: true });
  const port = await freePort();
  fs.mkdirSync(path.join(temp, "state", "agents", APP), { recursive: true });
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-inbox-audit-browser", mentionPolicy: "require",
    inboxAudit: { enabled: false, intervalMs: 60_060 }, activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "default", createdAt: "2026-09-06T00:00:00.000Z" } },
  }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "app", "dashboard.mjs"), "--port", String(port)], {
    cwd: ROOT, env: { ...process.env, HOME: temp, LARKIN_CONFIG_DIR: temp, CODEX_HOME: path.join(temp, "codex-home") }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const remoteRequests = [];
  await page.route("**/api/models/**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ id: "default", label: "default" }] }) }));
  page.on("request", (request) => { if (!request.url().startsWith(`http://localhost:${port}`)) remoteRequests.push(request.url()); });
  try {
    await waitReady(path.join(temp, "dashboard-status.json"), child, () => logs);
    const base = `http://localhost:${port}`;
    await page.goto(`${base}/?agent=${APP}&tab=configuration`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: APP, level: 1 }).waitFor({ timeout: 5_000 });

    await page.getByRole("button", { name: "全局设置" }).click();
    const global = page.getByRole("dialog");
    assert.equal(await global.getByLabel("全局巡检间隔（分钟）").inputValue(), "1.001");
    await global.getByLabel("全局巡检间隔（分钟）").fill("30");
    await page.screenshot({ path: path.join(evidence, "desktop-inbox-audit-global.png"), fullPage: true });
    await global.getByRole("button", { name: "保存全局设置" }).click();
    await global.getByRole("status").getByText(/已保存/).waitFor();
    assert.equal(await global.getByLabel("Inbox 巡检开关").isChecked(), false, "gap-only save must not enable audit");
    await global.getByRole("button", { name: "关闭面板" }).click();

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "全局设置" }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="全局巡检间隔（分钟）"]')?.value === "30");
    assert.equal(await global.getByLabel("全局巡检间隔（分钟）").inputValue(), "30");
    assert.equal(await global.getByLabel("Inbox 巡检开关").isChecked(), false);
    await global.getByRole("button", { name: "关闭面板" }).click();

    await page.getByLabel("Inbox 巡检设置").selectOption("on");
    await page.getByLabel("Agent 巡检间隔（分钟）").fill("45");
    await page.getByRole("button", { name: "保存 Agent 配置" }).click();
    await page.getByRole("status").getByText(/已保存/).waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector('[aria-label="Inbox 巡检设置"]')?.value === "on");
    assert.equal(await page.getByLabel("Inbox 巡检设置").inputValue(), "on");
    assert.equal(await page.getByLabel("Agent 巡检间隔（分钟）").inputValue(), "45");

    await page.getByLabel("Inbox 巡检设置").selectOption("off");
    await page.getByRole("button", { name: "保存 Agent 配置" }).click();
    await page.getByRole("status").getByText(/已保存/).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, "config.json"), "utf8")).agents[APP].inboxAudit.enabled, false);
    await page.getByLabel("Agent 巡检间隔（分钟）").fill("0");
    await page.getByRole("button", { name: "保存 Agent 配置" }).click();
    await page.getByRole("status").getByText(/巡检间隔必须在 1 到 1440 分钟之间/).waitFor();
    assert.equal(await page.getByLabel("Agent 巡检间隔（分钟）").inputValue(), "0");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(evidence, "mobile-inbox-audit-agent.png"), fullPage: true });
    const mobile = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(mobile.scrollWidth <= mobile.width, `mobile audit settings overflow: ${JSON.stringify(mobile)}`);
    assert.deepEqual(remoteRequests, [], "audit settings browser fixture must not request remote resources");
  } finally {
    await browser.close();
    child.kill("SIGINT");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
