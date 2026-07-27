// 本地集成测试：验证 dashboard 工作空间目录、文件预览和路径越界保护。
// 默认跳过；运行：RUN_DASHBOARD_WORKSPACE_TEST=1 bun test test/integration/dashboard/dashboard-workspace.test.mjs
import { test } from "bun:test";

const base = process.env.LARKIN_DASHBOARD_URL || "http://localhost:9996";
const enabled = process.env.RUN_DASHBOARD_WORKSPACE_TEST === "1";

test.skipIf(!enabled)("dashboard workspace API preserves preview and traversal boundaries", {
  timeout: 15_000,
}, async () => {
const html = await fetch(base + "/").then((r) => r.text());
if (!html.includes("height:66vh") || !html.includes(".workspace-list{ flex:1; overflow:auto") || !html.includes(".workspace-main{ min-width:0; min-height:0; overflow:hidden")) {
  throw new Error("工作空间缺少内部滚动约束");
}
const status = await fetch(base + "/api/status").then((r) => r.json());
const agentId = status.agents?.[0]?.agentId;
if (!agentId) throw new Error("dashboard 没有可测试的 agent");

const workspaceUrl = (relativePath) => base + "/api/workspace?agent=" + encodeURIComponent(agentId) + "&path=" + encodeURIComponent(relativePath);
const rootResponse = await fetch(workspaceUrl(""));
const root = await rootResponse.json();
if (!rootResponse.ok || root.kind !== "directory" || !root.entries.some((e) => e.name === "MEMORY.md" && e.kind === "file")) {
  throw new Error("工作空间根目录未返回 MEMORY.md");
}

const fileResponse = await fetch(workspaceUrl("MEMORY.md"));
const file = await fileResponse.json();
if (!fileResponse.ok || file.kind !== "file" || file.binary || typeof file.content !== "string") {
  throw new Error("MEMORY.md 预览失败");
}

const traversalResponse = await fetch(workspaceUrl("../config.json"));
if (traversalResponse.status !== 400) throw new Error(`路径越界应返回 400，实际 ${traversalResponse.status}`);

console.log(`PASS dashboard workspace: agent=${agentId}, entries=${root.entries.length}, MEMORY.md=${file.size} bytes, traversal=400`);
});
