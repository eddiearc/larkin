import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN = process.env.LARKIN_RUN_DASHBOARD_BROWSER_TEST === "1";
const CHROME = process.env.LARKIN_CHROMIUM_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const APP_A = "cli_WorkbenchA1";
const APP_B = "cli_WorkbenchB2";

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

function writeAgentState(root, agentId, name, chatId, runtime) {
  const state = path.join(root, "state", "agents", agentId);
  const workspace = path.join(root, "agents", agentId);
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), `# ${name}\n\nAgent workbench browser evidence.\n`);
  for (let index = 1; index <= 48; index += 1) {
    fs.writeFileSync(path.join(workspace, `fixture-${String(index).padStart(2, "0")}.txt`), `${name} workspace fixture ${index}\n`);
  }
  fs.writeFileSync(path.join(workspace, "LONG_PREVIEW.md"), Array.from({ length: 320 }, (_, index) => `Line ${String(index + 1).padStart(3, "0")} · ${name} independent preview scrolling fixture`).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "bot-identity.json"), JSON.stringify({ name, open_id: `ou_${agentId}`, avatar_url: `https://remote.invalid/${agentId}.png` }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "feishu-map.json"), JSON.stringify({ [`#${name}群`]: chatId }), { mode: 0o600 });
  const sessionId = `${runtime}-workbench-session`;
  fs.writeFileSync(path.join(state, "agent-state.json"), JSON.stringify({ sessions: { [runtime]: sessionId } }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "status.json"), JSON.stringify({
    connectedAt: "2026-07-24T10:00:00.000Z", inboundVerifiedAt: "2026-07-24T10:01:00.000Z",
    lastActivity: { state: "working", detail: `${name} 正在处理任务`, at: new Date().toISOString() },
    activityLog: [{ state: "tool", detail: "read files", tool: "Read", at: new Date().toISOString() }],
    deliverLog: [{ from: "idan", target: `#${name}群`, at: new Date().toISOString() }], recentErrors: [],
    session: { id: sessionId, runtime, model: runtime === "codex" ? "gpt-5.6-sol" : "default", turns: 3 },
    compaction: { sessionId, active: false, count: 9, lastFinishedAt: "2026-07-24T09:00:00.000Z" },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, "conversation.ndjson"), [
    { direction: "in", from: "idan", target: `#${name}群`, wake: true, text: `${name} 开始任务`, at: "2026-07-24T10:00:00.000Z" },
    { direction: "in", from: "旁听用户", target: `#${name}群`, wake: false, text: "只进入上下文", at: "2026-07-24T10:01:00.000Z" },
    { direction: "out", from: name, target: `#${name}群`, wake: false, text: `${name} 已完成任务`, at: "2026-07-24T10:02:00.000Z" },
  ].map(JSON.stringify).join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(state, "reminders.json"), JSON.stringify({ reminders: [{ title: `${name} 提醒`, status: "scheduled", fireAt: "2026-07-25T10:00:00.000Z" }] }), { mode: 0o600 });
}

test.skipIf(!RUN)("real Chromium exercises the Agent workbench at desktop and mobile widths", { timeout: 45_000 }, async () => {
  assert.equal(fs.existsSync(CHROME), true, `Chromium executable missing: ${CHROME}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-workbench-browser-"));
  const evidence = process.env.LARKIN_DASHBOARD_BROWSER_EVIDENCE_DIR || path.join(ROOT, "artifacts", "dashboard-workbench-browser");
  fs.mkdirSync(evidence, { recursive: true });
  const port = await freePort();
  writeAgentState(temp, APP_A, "研究员", "oc_ResearchRoom", "pi");
  writeAgentState(temp, APP_B, "Builder", "oc_BuildRoom", "codex");
  const codexHome = path.join(temp, "codex-home");
  const codexSession = path.join(codexHome, "sessions", "2026", "07", "24", "rollout-codex-workbench-session.jsonl");
  fs.mkdirSync(path.dirname(codexSession), { recursive: true });
  fs.writeFileSync(codexSession, [
    { type: "event_msg", timestamp: "2026-07-24T09:00:00.000Z", payload: { type: "task_started" } },
    { type: "event_msg", timestamp: "2026-07-24T09:01:00.000Z", payload: { type: "context_compacted" } },
    { type: "event_msg", timestamp: "2026-07-24T09:02:00.000Z", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 12_345 }, last_token_usage: { total_tokens: 678 }, model_context_window: 2_000 } } },
  ].map(JSON.stringify).join("\n") + "\n");
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-workbench-browser", mentionPolicy: "free", activeAgent: APP_B,
    agents: {
      [APP_A]: { runtime: "pi", model: "default", chatMentionPolicies: { oc_ResearchRoom: "free" }, createdAt: "2026-07-24T00:00:00.000Z" },
      [APP_B]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", mentionPolicy: "require", chatMentionPolicies: { oc_BuildRoom: "free" }, createdAt: "2026-07-24T00:00:00.000Z" },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "app", "dashboard.mjs"), "--port", String(port)], {
    cwd: ROOT, env: { ...process.env, LARKIN_CONFIG_DIR: temp, CODEX_HOME: codexHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const consoleProblems = [];
  const remoteRequests = [];
  let failStatus = false;
  let delayedConfig = false;
  await page.route("**/api/status", async (route) => {
    if (failStatus) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "synthetic poll outage" }) });
    else await route.continue();
  });
  await page.route("**/api/config?agent=*", async (route) => {
    if (delayedConfig) {
      const agentId = new URL(route.request().url()).searchParams.get("agent");
      await new Promise((resolve) => setTimeout(resolve, agentId === APP_A ? 400 : 20));
    }
    await route.continue();
  });
  await page.route("**/api/models/pi?agent=*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [
      { id: "default", label: "default: openai/gpt-5.2" },
      { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol · openai", supportedReasoningEfforts: ["off", "high"] },
    ] }) });
  });
  page.on("console", (message) => { if (["error", "warning"].includes(message.type())) consoleProblems.push(`${message.type()}: ${message.text()}`); });
  page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));
  page.on("request", (request) => { if (!request.url().startsWith(`http://localhost:${port}`)) remoteRequests.push(request.url()); });
  try {
    await waitReady(path.join(temp, "dashboard-status.json"), child, () => logs);
    const base = `http://localhost:${port}`;
    await page.goto(`${base}/?agent=${APP_B}&tab=configuration`, { waitUntil: "networkidle" });
    try { await page.getByRole("heading", { name: "Builder", level: 1 }).waitFor({ timeout: 5_000 }); }
    catch (error) { throw new Error(`${error.message}\nconsole=${JSON.stringify(consoleProblems)}\nbody=${(await page.locator("body").innerText()).slice(0, 2000)}`); }
    await assert.doesNotReject(page.getByRole("tab", { name: "配置" }).waitFor());
    assert.equal(await page.getByRole("tab", { name: "配置" }).getAttribute("aria-selected"), "true");
    await assert.doesNotReject(page.getByText("Builder群", { exact: true }).waitFor({ timeout: 5_000 }));
    assert.equal(await page.getByText(/覆盖链|effective|source|override/i).count(), 0, "implementation-oriented precedence details stay out of the UI");
    await assert.doesNotReject(page.getByText("累计 12,345 tokens").waitFor());
    await assert.doesNotReject(page.getByText("最近 678 tokens").waitFor());
    await assert.doesNotReject(page.getByText("Compact 1 次 · idle").waitFor());
    assert.match(page.url(), new RegExp(`agent=${APP_B}.*tab=configuration`));

    await page.getByRole("tab", { name: "日志" }).click({ timeout: 5_000 });
    const activeDot = page.locator(".logs-section .timeline-dot.state-active").first();
    await activeDot.waitFor({ timeout: 5_000 });
    assert.notEqual(await activeDot.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", "active timeline state needs a real computed lamp color");
    assert.deepEqual(await page.locator(".logs-section").evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius, background: getComputedStyle(element).backgroundColor,
    })), { radius: "0px", background: "rgba(0, 0, 0, 0)" }, "Logs must be a flat section");
    await page.getByRole("tab", { name: "提醒" }).click({ timeout: 5_000 });
    const scheduledReminder = page.locator(".reminder-list article.status-scheduled");
    await scheduledReminder.waitFor({ timeout: 5_000 });
    assert.equal(await scheduledReminder.evaluate((element) => getComputedStyle(element).borderLeftWidth), "3px", "scheduled reminder needs a real semantic border color treatment");
    assert.deepEqual(await scheduledReminder.evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius, divider: getComputedStyle(element).borderBottomWidth, background: getComputedStyle(element).backgroundColor,
    })), { radius: "0px", divider: "1px", background: "rgba(0, 0, 0, 0)" }, "Reminders must use flat divided rows");
    await page.getByRole("tab", { name: "配置" }).click({ timeout: 5_000 });
    assert.deepEqual(await page.locator(".config-section").evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius, background: getComputedStyle(element).backgroundColor,
    })), { radius: "0px", background: "rgba(0, 0, 0, 0)" }, "Configuration must use flat sections");

    const sidebarSearch = page.getByPlaceholder("搜索 Agent…");
    await sidebarSearch.focus();
    await page.waitForTimeout(3_250);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("placeholder")), "搜索 Agent…", "status polling must preserve focus");
    failStatus = true;
    await page.getByRole("alert").waitFor({ timeout: 5_000 });
    await assert.doesNotReject(page.getByRole("heading", { name: "Builder", level: 1 }).waitFor());
    failStatus = false;
    await page.getByRole("alert").getByRole("button", { name: "重试" }).click();
    await page.getByRole("alert").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "全局设置" }).click();
    await page.getByRole("dialog").getByLabel("真人群消息默认策略").selectOption("require");
    await page.getByRole("dialog").getByRole("button", { name: "保存全局设置" }).click();
    await assert.doesNotReject(page.getByRole("dialog").getByText(/已保存/).waitFor());
    await page.getByRole("dialog").getByRole("button", { name: "关闭面板" }).click();

    await page.getByLabel("Runtime").selectOption("claude");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("option", { name: /研究员/ }).click();
    await assert.doesNotReject(page.getByRole("heading", { name: "Builder", level: 1 }).waitFor());
    await page.getByRole("button", { name: "放弃草稿" }).click();
    await page.getByRole("tab", { name: "对话" }).click();
    await assert.doesNotReject(page.getByText("旁听 · 未唤醒").waitFor());
    await assert.doesNotReject(page.getByText("只进入上下文").waitFor());
    assert.deepEqual(await page.locator(".conversation-item").first().evaluate((element) => ({
      radius: getComputedStyle(element).borderRadius, divider: getComputedStyle(element).borderBottomWidth, background: getComputedStyle(element).backgroundColor,
    })), { radius: "0px", divider: "1px", background: "rgba(0, 0, 0, 0)" }, "Conversations must use flat divided rows");
    const seededScroll = await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "scroll-fixture";
      spacer.style.height = "1800px";
      document.querySelector(".conversation-list")?.append(spacer);
      window.scrollTo(0, 500);
      return { y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight };
    });
    assert.ok(seededScroll.y >= 450, `browser fixture must establish scroll before restore test: ${JSON.stringify(seededScroll)}`);
    const stickyTab = await page.getByRole("tab", { name: "配置" }).boundingBox();
    assert.ok(stickyTab && stickyTab.y >= 0 && stickyTab.y < 720, `sticky tab must remain user-visible while content scrolls: ${JSON.stringify(stickyTab)}`);
    await page.getByRole("tab", { name: "配置" }).evaluate((element) => element.click());
    await page.getByRole("tab", { name: "对话" }).evaluate((element) => element.click());
    await page.waitForFunction(() => window.scrollY >= 450);
    const restoredScroll = await page.evaluate((agentId) => ({
      actual: window.scrollY,
      conversation: sessionStorage.getItem(`larkin-dashboard-scroll:${agentId}:conversation`),
      configuration: sessionStorage.getItem(`larkin-dashboard-scroll:${agentId}:configuration`),
    }), APP_B);
    assert.ok(restoredScroll.actual >= 450, `per-Agent/tab scroll position must restore (${JSON.stringify(restoredScroll)})`);
    await page.evaluate(() => { document.getElementById("scroll-fixture")?.remove(); window.scrollTo(0, 0); });
    await page.getByRole("tab", { name: "配置" }).click();
    delayedConfig = true;
    await page.getByRole("option", { name: /研究员/ }).click();
    await page.getByRole("option", { name: /Builder/ }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByLabel("Runtime").inputValue(), "codex", "late previous-Agent config must not overwrite current Agent");
    delayedConfig = false;
    await page.getByRole("button", { name: "应用已保存配置" }).click();
    await assert.doesNotReject(page.getByText(/Agent 可能正忙，配置保持已保存/).waitFor());
    await page.getByRole("tab", { name: "概览" }).click();
    const flatGeometry = await page.evaluate(() => {
      const band = document.querySelector(".metrics-band");
      const section = document.querySelector(".content-section");
      const stat = document.querySelector(".metric-stat");
      return {
        bandRadius: band ? getComputedStyle(band).borderRadius : null,
        sectionRadius: section ? getComputedStyle(section).borderRadius : null,
        statBackground: stat ? getComputedStyle(stat).backgroundColor : null,
      };
    });
    assert.equal(flatGeometry.bandRadius, "0px", `Overview metrics must render as a flat divided band: ${JSON.stringify(flatGeometry)}`);
    assert.equal(flatGeometry.sectionRadius, "0px", `Overview content must render as flat sections: ${JSON.stringify(flatGeometry)}`);
    assert.equal(flatGeometry.statBackground, "rgba(0, 0, 0, 0)", `Overview metrics must not become individual cards: ${JSON.stringify(flatGeometry)}`);
    const desktopMetricGeometry = await page.evaluate(() => {
      const connection = [...document.querySelectorAll(".metric-stat")].find((element) => element.querySelector("span")?.textContent === "连接");
      const value = connection?.querySelector("strong");
      return {
        columns: getComputedStyle(document.querySelector(".metrics-band")).gridTemplateColumns.split(" ").length,
        text: value?.textContent, clientWidth: value?.clientWidth, scrollWidth: value?.scrollWidth,
      };
    });
    assert.equal(desktopMetricGeometry.columns, 4, `1280px viewport must use conservative metric columns: ${JSON.stringify(desktopMetricGeometry)}`);
    assert.equal(desktopMetricGeometry.text, "disconnected");
    assert.ok(desktopMetricGeometry.scrollWidth <= desktopMetricGeometry.clientWidth,
      `critical connection status must remain fully visible at 1280px: ${JSON.stringify(desktopMetricGeometry)}`);
    await page.screenshot({ path: path.join(evidence, "desktop.png"), fullPage: true });
    await page.getByRole("tab", { name: "工作区" }).click();
    await page.getByText("只读工作区").waitFor();
    const workspaceGeometry = await page.evaluate(() => {
      const content = document.querySelector(".agent-content.workspace-active")?.getBoundingClientRect();
      const browser = document.querySelector(".workspace-browser")?.getBoundingClientRect();
      return { viewport: innerHeight, documentHeight: document.documentElement.scrollHeight, contentBottom: content?.bottom, browserBottom: browser?.bottom };
    });
    assert.ok(Math.abs(workspaceGeometry.documentHeight - workspaceGeometry.viewport) <= 2, `desktop workspace should not create page-height slack: ${JSON.stringify(workspaceGeometry)}`);
    assert.ok(Math.abs(workspaceGeometry.contentBottom - workspaceGeometry.viewport) <= 2, `active content should fill the viewport: ${JSON.stringify(workspaceGeometry)}`);
    assert.ok(Math.abs(workspaceGeometry.browserBottom - (workspaceGeometry.viewport - 24)) <= 3, `workspace browser should fill the content area above its bottom padding: ${JSON.stringify(workspaceGeometry)}`);
    for (const viewport of [{ width: 800, height: 900 }, { width: 800, height: 600 }]) {
      await page.setViewportSize(viewport);
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText("只读工作区").waitFor();
      const narrowWorkspaceGeometry = await page.evaluate(() => {
        const shell = document.querySelector(".workspace-shell.workspace-route-active")?.getBoundingClientRect();
        const content = document.querySelector(".agent-content.workspace-active")?.getBoundingClientRect();
        const browser = document.querySelector(".workspace-browser")?.getBoundingClientRect();
        return {
          viewport: innerHeight, documentHeight: document.documentElement.scrollHeight,
          shellHeight: shell?.height, contentBottom: content?.bottom, browserBottom: browser?.bottom,
        };
      });
      assert.ok(Math.abs(narrowWorkspaceGeometry.documentHeight - narrowWorkspaceGeometry.viewport) <= 2,
        `${viewport.width}x${viewport.height} Workspace must not create body scroll when the summary wraps: ${JSON.stringify(narrowWorkspaceGeometry)}`);
      assert.ok(Math.abs(narrowWorkspaceGeometry.shellHeight - narrowWorkspaceGeometry.viewport) <= 2,
        `active Workspace shell must own exactly the viewport: ${JSON.stringify(narrowWorkspaceGeometry)}`);
      assert.ok(Math.abs(narrowWorkspaceGeometry.contentBottom - narrowWorkspaceGeometry.viewport) <= 2,
        `natural remaining content must end at the viewport: ${JSON.stringify(narrowWorkspaceGeometry)}`);
      assert.ok(Math.abs(narrowWorkspaceGeometry.browserBottom - (narrowWorkspaceGeometry.viewport - 24)) <= 3,
        `Workspace browser must retain bottom padding at ${viewport.width}x${viewport.height}: ${JSON.stringify(narrowWorkspaceGeometry)}`);
    }
    const directoryRegion = page.getByRole("region", { name: "工作区目录" });
    const previewRegion = page.getByRole("region", { name: "文件预览" });
    await page.getByRole("button", { name: /LONG_PREVIEW\.md/ }).click();
    await previewRegion.getByText("LONG_PREVIEW.md", { exact: true }).waitFor();
    const desktopScrollBounds = await page.evaluate(() => {
      const directory = document.querySelector(".workspace-list");
      const preview = document.querySelector(".workspace-preview");
      return {
        directory: { client: directory?.clientHeight, scroll: directory?.scrollHeight },
        preview: { client: preview?.clientHeight, scroll: preview?.scrollHeight },
      };
    });
    assert.ok(desktopScrollBounds.directory.scroll > desktopScrollBounds.directory.client, `desktop directory fixture must overflow its own region: ${JSON.stringify(desktopScrollBounds)}`);
    assert.ok(desktopScrollBounds.preview.scroll > desktopScrollBounds.preview.client, `desktop preview fixture must overflow its own region: ${JSON.stringify(desktopScrollBounds)}`);
    await page.evaluate(() => { document.querySelector(".workspace-list").scrollTop = 0; document.querySelector(".workspace-preview").scrollTop = 0; });
    await directoryRegion.hover();
    await page.mouse.wheel(0, 280);
    await page.waitForFunction(() => document.querySelector(".workspace-list")?.scrollTop > 0);
    const afterDirectoryScroll = await page.evaluate(() => ({ directory: document.querySelector(".workspace-list").scrollTop, preview: document.querySelector(".workspace-preview").scrollTop }));
    assert.equal(afterDirectoryScroll.preview, 0, `scrolling the desktop directory must not move preview: ${JSON.stringify(afterDirectoryScroll)}`);
    await previewRegion.hover();
    await page.mouse.wheel(0, 320);
    await page.waitForFunction(() => document.querySelector(".workspace-preview")?.scrollTop > 0);
    const afterPreviewScroll = await page.evaluate(() => ({ directory: document.querySelector(".workspace-list").scrollTop, preview: document.querySelector(".workspace-preview").scrollTop }));
    assert.equal(afterPreviewScroll.directory, afterDirectoryScroll.directory, `scrolling the desktop preview must not move directory: ${JSON.stringify({ afterDirectoryScroll, afterPreviewScroll })}`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidence, "desktop-workspace.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(overflow.scrollWidth <= overflow.width, `mobile overflow ${JSON.stringify(overflow)}`);
    await page.getByRole("button", { name: /LONG_PREVIEW\.md/ }).click();
    await page.getByRole("region", { name: "文件预览" }).getByText("LONG_PREVIEW.md", { exact: true }).waitFor();
    const mobileScrollBounds = await page.evaluate(() => {
      const directory = document.querySelector(".workspace-list");
      const preview = document.querySelector(".workspace-preview");
      return {
        directory: { client: directory?.clientHeight, scroll: directory?.scrollHeight },
        preview: { client: preview?.clientHeight, scroll: preview?.scrollHeight },
      };
    });
    assert.ok(mobileScrollBounds.directory.scroll > mobileScrollBounds.directory.client, `mobile directory must remain bounded and scrollable: ${JSON.stringify(mobileScrollBounds)}`);
    assert.ok(mobileScrollBounds.preview.scroll > mobileScrollBounds.preview.client, `mobile preview must remain bounded and scrollable: ${JSON.stringify(mobileScrollBounds)}`);
    await page.evaluate(() => { document.querySelector(".workspace-list").scrollTop = 0; document.querySelector(".workspace-preview").scrollTop = 0; });
    await page.getByRole("region", { name: "工作区目录" }).hover();
    await page.mouse.wheel(0, 180);
    await page.waitForFunction(() => document.querySelector(".workspace-list")?.scrollTop > 0);
    const mobileAfterDirectory = await page.evaluate(() => ({ directory: document.querySelector(".workspace-list").scrollTop, preview: document.querySelector(".workspace-preview").scrollTop }));
    assert.equal(mobileAfterDirectory.preview, 0, `scrolling the mobile directory must not move preview: ${JSON.stringify(mobileAfterDirectory)}`);
    await page.getByRole("region", { name: "文件预览" }).hover();
    await page.mouse.wheel(0, 220);
    await page.waitForFunction(() => document.querySelector(".workspace-preview")?.scrollTop > 0);
    const mobileAfterPreview = await page.evaluate(() => ({ directory: document.querySelector(".workspace-list").scrollTop, preview: document.querySelector(".workspace-preview").scrollTop }));
    assert.equal(mobileAfterPreview.directory, mobileAfterDirectory.directory, `scrolling the mobile preview must not move directory: ${JSON.stringify({ mobileAfterDirectory, mobileAfterPreview })}`);
    const directoryBoundary = await page.evaluate(async () => {
      const directory = document.querySelector(".workspace-list");
      directory.scrollTop = directory.scrollHeight;
      window.scrollTo(0, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        overscroll: getComputedStyle(directory).overscrollBehaviorY,
        scrollTop: directory.scrollTop, max: directory.scrollHeight - directory.clientHeight,
        documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, windowY: window.scrollY,
      };
    });
    assert.equal(directoryBoundary.overscroll, "auto", `mobile directory must release boundary scrolling: ${JSON.stringify(directoryBoundary)}`);
    assert.ok(Math.abs(directoryBoundary.scrollTop - directoryBoundary.max) <= 1 && directoryBoundary.documentHeight > directoryBoundary.viewport,
      `mobile directory fixture must be at a real body-scrollable boundary: ${JSON.stringify(directoryBoundary)}`);
    await page.getByRole("region", { name: "工作区目录" }).hover();
    await page.mouse.wheel(0, 260);
    await page.mouse.wheel(0, 260);
    await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3_000 });
    const previewBoundary = await page.evaluate(async () => {
      const preview = document.querySelector(".workspace-preview");
      preview.scrollTop = preview.scrollHeight;
      window.scrollTo(0, 0);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        overscroll: getComputedStyle(preview).overscrollBehaviorY,
        scrollTop: preview.scrollTop, max: preview.scrollHeight - preview.clientHeight,
        documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, windowY: window.scrollY,
      };
    });
    assert.equal(previewBoundary.overscroll, "auto", `mobile preview must release boundary scrolling: ${JSON.stringify(previewBoundary)}`);
    assert.ok(Math.abs(previewBoundary.scrollTop - previewBoundary.max) <= 1 && previewBoundary.documentHeight > previewBoundary.viewport,
      `mobile preview fixture must be at a real body-scrollable boundary: ${JSON.stringify(previewBoundary)}`);
    await page.getByRole("region", { name: "文件预览" }).hover();
    await page.mouse.wheel(0, 260);
    await page.mouse.wheel(0, 260);
    await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 3_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(evidence, "mobile-workspace.png"), fullPage: true });
    await page.getByRole("tab", { name: "概览" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const narrowOverviewGeometry = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector(".metrics-band")).gridTemplateColumns.split(" ").length,
      recentActivityY: document.querySelector(".content-section h3")?.getBoundingClientRect().y,
    }));
    assert.equal(narrowOverviewGeometry.columns, 2, `390px Overview must keep a compact two-column metric band: ${JSON.stringify(narrowOverviewGeometry)}`);
    assert.ok(narrowOverviewGeometry.recentActivityY < 750, `390px 最近动态 must remain above y=750: ${JSON.stringify(narrowOverviewGeometry)}`);
    await page.screenshot({ path: path.join(evidence, "mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "打开 Agent 导航" }).click();
    await assert.doesNotReject(page.getByRole("dialog").getByRole("heading", { name: "选择 Agent" }).waitFor());
    assert.equal(consoleProblems.filter((message) => message.includes("409 (Conflict)")).length, 1, "expected rejected apply error missing");
    assert.ok(consoleProblems.some((message) => message.includes("503 (Service Unavailable)")), "expected synthetic polling outage console evidence missing");
    assert.deepEqual(consoleProblems.filter((message) => !message.includes("409 (Conflict)") && !message.includes("503 (Service Unavailable)")), []);
    assert.deepEqual(remoteRequests, [], "dashboard must not request remote avatar/font/CDN resources");
  } finally {
    await browser.close();
    child.kill("SIGINT");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
