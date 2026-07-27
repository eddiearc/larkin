import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("dashboard ships an authored React Agent workbench instead of an inline card wall", () => {
  const app = read("src/dashboard/web/app.tsx");
  const state = read("src/dashboard/web/dashboard-state.ts");
  const template = read("src/dashboard/dashboard-template.ts");
  assert.match(app, /AgentSidebar/);
  assert.match(app, /GlobalSettingsSheet/);
  assert.match(app, /GroupPolicyTable/);
  for (const tab of ["overview", "conversation", "configuration", "reminders", "workspace", "logs"]) {
    assert.match(state, new RegExp(`(?:^|[\\s\"'])${tab}(?:[\\s\"',]|$)`));
  }
  assert.match(template, /dashboard-assets\/dashboard\.css/);
  assert.match(template, /dashboard-assets\/dashboard\.js/);
  assert.doesNotMatch(template, /function renderAgents|class="grid"/);
});

test("dashboard build and server own the offline Vite assets", () => {
  const build = read("scripts/build.mjs");
  const server = read("src/app/dashboard.ts");
  const standalone = read("scripts/release/standalone-entry.ts");
  const pkg = JSON.parse(read("package.json"));
  assert.match(build, /vite/);
  assert.match(build, /"dashboard", "web"/);
  assert.match(server, /dashboard-assets/);
  assert.match(server, /dashboardAsset/);
  assert.match(standalone, /dashboard\.css/);
  assert.match(standalone, /dashboard\.js/);
  assert.match(standalone, /larkin-mark\.svg/);
  assert.ok(pkg.dependencies.react || pkg.devDependencies.react);
  assert.ok(pkg.devDependencies.vite);
  assert.ok(pkg.devDependencies.tailwindcss);
});

test("dashboard stylesheet defines semantic reminder, timeline, and active-workspace states", () => {
  const styles = read("src/dashboard/web/styles.css");
  assert.match(styles, /\.reminder-list article\.done\b[^}]*\{[^}]*text-decoration:\s*line-through/s,
    "completed reminders need a visible done treatment");
  for (const state of ["scheduled", "pending", "fired", "canceled", "failed"]) {
    assert.match(styles, new RegExp(`\\.reminder-list article\\.status-${state}\\b`), `reminder ${state} needs a semantic class rule`);
  }
  for (const state of ["active", "idle", "deliver", "error", "unknown"]) {
    assert.match(styles, new RegExp(`\\.timeline-dot\\.state-${state}\\b`), `timeline ${state} needs a semantic dot rule`);
  }
  assert.match(styles, /\.app-shell\.workspace-app-active\b[^}]*\{[^}]*height:\s*100vh[^}]*height:\s*100dvh[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s,
    "the active desktop workspace route must bound the complete grid to the viewport");
  assert.match(styles, /\.workspace-shell\.workspace-route-active\b[^}]*\{[^}]*height:\s*100vh[^}]*height:\s*100dvh[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s,
    "the active Workspace main column must own the viewport height while sizing its rows naturally");
  assert.match(styles, /\.agent-content\.workspace-active\b[^}]*\{[^}]*height:\s*auto[^}]*flex:\s*1 1 0[^}]*overflow:\s*hidden/s,
    "Workspace content must consume natural remaining height instead of subtracting a hard-coded header height");
});

test("dashboard uses flat sections and two bounded Workspace scroll regions", () => {
  const app = read("src/dashboard/web/app.tsx");
  const styles = read("src/dashboard/web/styles.css");
  assert.match(app, /className="metrics-band"/);
  assert.match(app, /className="content-section/);
  assert.match(app, /className="config-section"/);
  assert.match(app, /className="logs-section"/);
  assert.doesNotMatch(app, /className="(?:metric-card|content-card|config-card|logs-panel)/,
    "major content areas must not return to card-wall primitives");
  assert.match(styles, /\.conversation-item, \.reminder-list article\s*\{[^}]*border-bottom:\s*1px solid var\(--line\)[^}]*background:\s*transparent/s);
  assert.match(styles, /\.workspace-list\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(styles, /\.workspace-preview\s*\{[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(styles, /\.workspace-list, \.workspace-preview\s*\{[^}]*overscroll-behavior:\s*auto/s,
    "mobile Workspace regions must release wheel/touch scrolling to the body at their boundaries");
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*\.metrics-band\s*\{[^}]*repeat\(2,/,
    "narrow mobile Overview must retain a compact two-column metric band");
  assert.match(styles, /\.metrics-band\s*\{[^}]*repeat\(4,/,
    "ordinary desktop widths must use conservative metric columns");
  assert.match(styles, /@media \(min-width: 1600px\)[\s\S]*\.metrics-band\s*\{[^}]*repeat\(7,/,
    "the seven-column metric band is reserved for genuinely wide viewports");
  assert.match(app, /aria-label="工作区目录"/);
  assert.match(app, /aria-label="文件预览"/);
});

test("dashboard Pi model directory is wired to the official catalog authority", () => {
  const controller = read("src/dashboard/dashboard-config-controller.ts");
  assert.match(controller, /import\s*\{[^}]*discoverPiModelCatalog[^}]*\}\s*from\s*["']\.\.\/runtime\/pi-model-catalog\.js["']/s,
    "Dashboard Pi discovery must reuse discoverPiModelCatalog instead of creating another catalog implementation");
  assert.match(controller, /createPiModelDirectoryResolver/);
  assert.match(controller, /\/api\/models\/pi/);
});
