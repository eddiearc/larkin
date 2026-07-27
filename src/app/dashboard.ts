#!/usr/bin/env bun
import "../platform/check-bun-version.cjs";
// Internal dashboard child —— 本地监控与受限配置面板，由 larkin start supervisor 启动和恢复。
// 连接状态/各自的活动时间线/指示灯是否卡住/最近错误/工作空间/提醒。Ctrl+C 停止，不常驻、不落 launchd
// （与 start 同哲学）。零新依赖：只用 node:http 读本地状态文件，不打飞书 API，所以哪怕 daemon
// 没在跑也能看最后一次的状态（daemon 存活单独判定：daemon-status.json 的 pid 探活）。
//
// 分层：本文件只做 server/controller（端口、锁、路由、退出）；状态投影在 dashboard-view-model.ts，
// 页面模板在 dashboard-template.ts。
//
// 内部启动参数：默认从 9996 开始，端口占用时依次尝试；`--port` 可固定测试端口。
// 公开入口只有 `larkin start`，不要重新暴露独立 dashboard 命令。

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentProcessMetadata, readJson } from "../platform/process-state.js";
import { prepareDashboardLaunch } from "../dashboard/dashboard-lifecycle.js";
import { DASHBOARD_BUILD_FINGERPRINT, DASHBOARD_BUILD_VERSION, PACKAGE_VERSION, collectStatus, collectWorkspaceEntry, loadDashboardConfig, resolveDashboardAvatarSource } from "../dashboard/dashboard-view-model.js";
import { renderDashboardHtml } from "../dashboard/dashboard-template.js";
import { createDashboardConfigController, createPiModelDirectoryResolver } from "../dashboard/dashboard-config-controller.js";
import { createDashboardAvatarController } from "../dashboard/dashboard-avatar.js";
import { processCommandToken } from "./internal-command.js";
import { dashboardAsset } from "../dashboard/dashboard-assets.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string): boolean => argv.includes(name);
const explicitPort = flag("--port");
let port = Number(explicitPort || process.env.LARKIN_DASHBOARD_PORT || 9996);
const listenHost = "127.0.0.1"; // 会话摘要只允许本机读取，不能意外暴露到局域网。
const autoSelectPort = !explicitPort;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("✗ dashboard 端口必须是 1-65535 的整数");
  process.exit(1);
}
const { config: startupConfig } = loadDashboardConfig();
const DASHBOARD_STATUS_FILE = path.join(startupConfig.larkinHome, "dashboard-status.json");
const BUILD_FINGERPRINT = DASHBOARD_BUILD_FINGERPRINT;
const DASHBOARD_COMMAND_TOKEN = processCommandToken("dashboard", "app/dashboard.mjs");

function openBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

let preparedDashboard;
try { preparedDashboard = await prepareDashboardLaunch(startupConfig.larkinHome, BUILD_FINGERPRINT, DASHBOARD_COMMAND_TOKEN); }
catch (error) { console.error(`✗ 无法准备 dashboard：${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
if (preparedDashboard.action === "reuse") {
  preparedDashboard.release();
  console.log(`✓ dashboard 已在运行（pid ${preparedDashboard.record.pid}）：${preparedDashboard.record.url}`);
  if (has("--open") && preparedDashboard.record.url) {
    const existingUrl = String(preparedDashboard.record.url);
    console.log(openBrowser(existingUrl) ? "dashboard 已在默认浏览器打开" : `请手动打开 ${existingUrl}`);
  }
  process.exit(0);
}
const dashboardLaunchLock = { release: preparedDashboard.release };

const csrfCapability = crypto.randomBytes(32).toString("base64url");
const HTML = renderDashboardHtml(PACKAGE_VERSION, DASHBOARD_BUILD_VERSION, BUILD_FINGERPRINT, csrfCapability);
const piModelResolver = createPiModelDirectoryResolver();
const configController = createDashboardConfigController({ csrfCapability, piModelDirectoryResolver: piModelResolver });
const avatarController = createDashboardAvatarController({ resolveSource: resolveDashboardAvatarSource });

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (req.url === "/assets/larkin-mark.svg") {
    const asset = dashboardAsset("larkin-mark.svg", ROOT);
    if (!asset) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=3600" });
    res.end(asset.body);
    return;
  }
  const webAsset = /^\/dashboard-assets\/([A-Za-z0-9._-]+)$/.exec(requestUrl.pathname);
  if (webAsset) {
    const name = webAsset[1];
    if (name !== "dashboard.css" && name !== "dashboard.js") { res.writeHead(404); res.end("not found"); return; }
    const asset = dashboardAsset(name, ROOT);
    if (!asset) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(asset.body);
    return;
  }
  if (req.url === "/api/status") {
    let body;
    try { body = JSON.stringify(await collectStatus({ piModelResolver })); }
    catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  if (await avatarController.handle(req, res, requestUrl)) return;
  if (await configController.handle(req, res, requestUrl)) return;
  if (requestUrl.pathname === "/api/workspace") {
    try {
      const body = JSON.stringify(collectWorkspaceEntry(requestUrl.searchParams.get("agent"), requestUrl.searchParams.get("path") || ""));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (requestUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(HTML);
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE" && autoSelectPort && port < 65535) {
    const occupied = port++;
    console.error(`端口 ${occupied} 已被占用，尝试 ${port}…`);
    server.listen(port, listenHost);
    return;
  }
  dashboardLaunchLock.release();
  const reason = error.code === "EADDRINUSE"
    ? (autoSelectPort ? "已尝试到端口上限 65535" : `指定端口 ${port} 已被占用`)
    : error.message;
  console.error("✗ dashboard 启动失败: " + reason);
  process.exit(1);
});

server.listen(port, listenHost, () => {
  const url = `http://localhost:${port}`;
  fs.mkdirSync(path.dirname(DASHBOARD_STATUS_FILE), { recursive: true });
  fs.writeFileSync(DASHBOARD_STATUS_FILE, JSON.stringify({
    ...currentProcessMetadata(DASHBOARD_COMMAND_TOKEN),
    pid: process.pid,
    port,
    url,
    startedAt: new Date().toISOString(),
    buildFingerprint: BUILD_FINGERPRINT,
  }, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(DASHBOARD_STATUS_FILE, 0o600); } catch {}
  dashboardLaunchLock.release();
  console.log(`larkin dashboard ready: ${url}  (由 larkin start 管理；仅本机访问，配置编辑受 CSRF 保护)`);
  if (has("--open")) console.log(openBrowser(url) ? "dashboard 已在默认浏览器打开" : "未能自动打开浏览器，请手动打开上面的地址");
});
function clearDashboardStatus() {
  const current = readJson<{ pid?: number } | null>(DASHBOARD_STATUS_FILE, null);
  if (current?.pid === process.pid) { try { fs.unlinkSync(DASHBOARD_STATUS_FILE); } catch {} }
}
let stopping = false;
let stopped = false;
const finishStop = () => {
  if (stopped) return;
  stopped = true;
  clearDashboardStatus();
  console.log("\n已停止");
  process.exit(0);
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close(finishStop);
  server.closeAllConnections?.();
  setTimeout(finishStop, 2000).unref();
};
process.on("exit", () => { dashboardLaunchLock.release(); clearDashboardStatus(); });
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
