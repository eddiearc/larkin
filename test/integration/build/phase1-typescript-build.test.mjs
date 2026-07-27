import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE_ROOT_LAYOUT = path.join(ROOT, "src/platform/root-layout.ts");
const SOURCE_CONFIG = path.join(ROOT, "src/platform/config.ts");
const SOURCE_PROCESS_INSPECT = path.join(ROOT, "src/platform/process-inspect.cts");
const SOURCE_PROCESS_STATE = path.join(ROOT, "src/platform/process-state.ts");
const SOURCE_DASHBOARD_LIFECYCLE = path.join(ROOT, "src/dashboard/dashboard-lifecycle.ts");
const SOURCE_MESSAGE_POLICY = path.join(ROOT, "src/feishu/message-policy.ts");
const SOURCE_AGENT_STATE_STORE = path.join(ROOT, "src/agent/agent-state-store.ts");
const SOURCE_HOST_BUSINESS_STATE = path.join(ROOT, "src/feishu/host-business-state.ts");
const SOURCE_HOST_SHELL = path.join(ROOT, "src/feishu/host-shell.ts");
const SOURCE_AGENT_CONFIG = path.join(ROOT, "src/app/agent-config.ts");
const SOURCE_SETUP = path.join(ROOT, "src/app/setup.ts");
const SOURCE_RUN = path.join(ROOT, "src/app/run.ts");
const SOURCE_CLI = path.join(ROOT, "src/app/cli.ts");
const SOURCE_OUTBOUND_TRANSPORT = path.join(ROOT, "src/feishu/outbound-transport.ts");
const SOURCE_CHANNEL_TRANSPORT = path.join(ROOT, "src/feishu/channel-transport.ts");
const SOURCE_REMINDER_ROUTES = path.join(ROOT, "src/agent/reminder-routes.ts");
const SOURCE_TRANSPORT_BUSINESS_CONTEXT = path.join(ROOT, "src/agent/transport-business-context.ts");
const SOURCE_WORKSPACE_SERVICE = path.join(ROOT, "src/platform/workspace-service.ts");
const SHELL_BUILDER = path.join(ROOT, "scripts/build.mjs");
const SHELL_PACKAGE = path.join(ROOT, "package.json");
const BUILT_ROOT_LAYOUT = path.join(ROOT, "dist/platform/root-layout.mjs");
const BUILT_ROOT_LAYOUT_CJS = path.join(ROOT, "dist/platform/root-layout.cjs");
const BUILT_CONFIG = path.join(ROOT, "dist/platform/config.cjs");
const BUILT_PROCESS_INSPECT = path.join(ROOT, "dist/platform/process-inspect.cjs");
const BUILT_PROCESS_STATE = path.join(ROOT, "dist/platform/process-state.mjs");
const BUILT_DASHBOARD_LIFECYCLE = path.join(ROOT, "dist/dashboard/dashboard-lifecycle.mjs");
const BUILT_MESSAGE_POLICY_ESM = path.join(ROOT, "dist/feishu/message-policy.mjs");
const BUILT_MESSAGE_POLICY_CJS = path.join(ROOT, "dist/feishu/message-policy.cjs");
const BUILT_AGENT_STATE_STORE_ESM = path.join(ROOT, "dist/agent/agent-state-store.mjs");
const BUILT_AGENT_STATE_STORE_CJS = path.join(ROOT, "dist/agent/agent-state-store.cjs");
const BUILT_HOST_BUSINESS_STATE_ESM = path.join(ROOT, "dist/feishu/host-business-state.mjs");
const BUILT_HOST_BUSINESS_STATE_CJS = path.join(ROOT, "dist/feishu/host-business-state.cjs");
const BUILT_HOST_SHELL_ESM = path.join(ROOT, "dist/feishu/host-shell.mjs");
const BUILT_HOST_SHELL_CJS = path.join(ROOT, "dist/feishu/host-shell.cjs");
const BUILT_AGENT_CONFIG = path.join(ROOT, "dist/app/agent-config.mjs");
const BUILT_SETUP = path.join(ROOT, "dist/app/setup.mjs");
const BUILT_RUN = path.join(ROOT, "dist/app/run.mjs");
const BUILT_CLI = path.join(ROOT, "dist/app/cli.mjs");
const BUILT_OUTBOUND_TRANSPORT_ESM = path.join(ROOT, "dist/feishu/outbound-transport.mjs");
const BUILT_OUTBOUND_TRANSPORT_CJS = path.join(ROOT, "dist/feishu/outbound-transport.cjs");
const BUILT_CHANNEL_TRANSPORT_ESM = path.join(ROOT, "dist/feishu/channel-transport.mjs");
const BUILT_CHANNEL_TRANSPORT_CJS = path.join(ROOT, "dist/feishu/channel-transport.cjs");
const BUILT_REMINDER_ROUTES_ESM = path.join(ROOT, "dist/agent/reminder-routes.mjs");
const BUILT_REMINDER_ROUTES_CJS = path.join(ROOT, "dist/agent/reminder-routes.cjs");
const BUILT_TRANSPORT_BUSINESS_CONTEXT = path.join(ROOT, "dist/agent/transport-business-context.cjs");
const BUILT_WORKSPACE_SERVICE = path.join(ROOT, "dist/platform/workspace-service.mjs");
const REMOVED_LAYOUT_MODULES = [
  "layout-inventory",
  "layout-planner",
  "layout-transaction",
  "layout-manifest-store",
  "layout-transaction-executor",
  "child-instrumentation",
];

function countFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + (
    entry.isDirectory() ? countFiles(path.join(directory, entry.name)) : 1
  ), 0);
}

async function loadRootLayout() {
  return import(pathToFileURL(BUILT_ROOT_LAYOUT).href);
}

test("Phase 1 ships TypeScript shell sources and loadable build artifacts", async () => {
  const required = [
    SOURCE_ROOT_LAYOUT,
    SOURCE_CONFIG,
    SOURCE_PROCESS_INSPECT,
    SOURCE_PROCESS_STATE,
    SOURCE_DASHBOARD_LIFECYCLE,
    SOURCE_MESSAGE_POLICY,
    SOURCE_AGENT_STATE_STORE,
    SOURCE_HOST_BUSINESS_STATE,
    SOURCE_HOST_SHELL,
    SOURCE_AGENT_CONFIG,
    SOURCE_SETUP,
    SOURCE_RUN,
    SOURCE_CLI,
    SOURCE_OUTBOUND_TRANSPORT,
    SOURCE_CHANNEL_TRANSPORT,
    SOURCE_REMINDER_ROUTES,
    SOURCE_TRANSPORT_BUSINESS_CONTEXT,
    SOURCE_WORKSPACE_SERVICE,
    SHELL_BUILDER,
    SHELL_PACKAGE,
    BUILT_ROOT_LAYOUT,
    BUILT_ROOT_LAYOUT_CJS,
    BUILT_CONFIG,
    BUILT_PROCESS_INSPECT,
    BUILT_PROCESS_STATE,
    BUILT_DASHBOARD_LIFECYCLE,
    BUILT_MESSAGE_POLICY_ESM,
    BUILT_MESSAGE_POLICY_CJS,
    BUILT_AGENT_STATE_STORE_ESM,
    BUILT_AGENT_STATE_STORE_CJS,
    BUILT_HOST_BUSINESS_STATE_ESM,
    BUILT_HOST_BUSINESS_STATE_CJS,
    BUILT_HOST_SHELL_ESM,
    BUILT_HOST_SHELL_CJS,
    BUILT_AGENT_CONFIG,
    BUILT_SETUP,
    BUILT_RUN,
    BUILT_CLI,
    BUILT_OUTBOUND_TRANSPORT_ESM,
    BUILT_OUTBOUND_TRANSPORT_CJS,
    BUILT_CHANNEL_TRANSPORT_ESM,
    BUILT_CHANNEL_TRANSPORT_CJS,
    BUILT_REMINDER_ROUTES_ESM,
    BUILT_REMINDER_ROUTES_CJS,
    BUILT_TRANSPORT_BUSINESS_CONTEXT,
    BUILT_WORKSPACE_SERVICE,
  ];
  const missing = required.filter((file) => !fs.existsSync(file)).map((file) => path.relative(ROOT, file));
  assert.deepEqual(missing, [], `TypeScript outside-in shell is not built; missing: ${missing.join(", ")}`);

  const [rootLayout, workspaceService] = await Promise.all([
    loadRootLayout(),
    import(pathToFileURL(BUILT_WORKSPACE_SERVICE).href),
  ]);
  assert.equal(typeof rootLayout.planRootLayout, "function");
  assert.deepEqual(Object.keys(rootLayout).sort(), ["TargetRootLayout", "planRootLayout", "resolveConfigDir"]);
  assert.equal(typeof workspaceService.reconcileAgentWorkspace, "function");
});

test("authored product code and generated runtime have one root-level authority", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "fork")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "packages")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "dist/platform/process-inspect.cjs")), true);
  const runtimeProcess = fs.readFileSync(path.join(ROOT, "src/app/runtime-process.ts"), "utf8");
  const hostShell = fs.readFileSync(path.join(ROOT, "src/feishu/host-shell.ts"), "utf8");
  assert.match(runtimeProcess, /from ["']\.\.\/feishu\/host-shell\.js["']/);
  assert.match(hostShell, /from ["']\.\.\/platform\/process-inspect\.cjs["']/);

  const authoredProcessState = fs.readFileSync(SOURCE_PROCESS_STATE, "utf8");
  assert.match(authoredProcessState, /import processInspectImport from ["']\.\/process-inspect\.cjs["']/);
  assert.doesNotMatch(authoredProcessState, /createRequire|\brequire\(/);
});

test("schema v3 config authority is authored in TypeScript and compiled directly", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/platform/config.cjs"), "utf8");
  assert.match(runtime, /function\s+(normalizeConfig|loadConfig|hydrateAgent|toStored)/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  const config = require(BUILT_CONFIG);
  for (const name of ["normalizeConfig", "loadConfig", "hydrateAgent", "selectAgent", "toStored"]) {
    assert.equal(typeof config[name], "function", name);
  }
});

test("agent configuration CLI is authored in strict TypeScript and compiled directly", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/app/agent-config.mjs"), "utf8");
  assert.match(runtime, /check-bun-version\.cjs/);
  assert.match(runtime, /process-state\.mjs/);
  assert.match(fs.readFileSync(SOURCE_AGENT_CONFIG, "utf8"), /from ["']\.\.\/platform\/process-state\.js["']/);
  assert.equal(fs.existsSync(BUILT_AGENT_CONFIG), true);
});

test("setup onboarding orchestration is authored in strict TypeScript as a direct entry", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/app/setup.mjs"), "utf8");
  assert.match(runtime, /^#!\/usr\/bin\/env bun/);
  assert.match(runtime, /main\(\)\.catch/);
  assert.equal(fs.existsSync(SOURCE_SETUP), true);
  assert.equal(fs.existsSync(BUILT_SETUP), true);
});

test("run orchestration is authored in strict TypeScript as a direct entry", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/app/run.mjs"), "utf8");
  assert.match(runtime, /^#!\/usr\/bin\/env bun/);
  assert.match(runtime, /\bmain\(\)/);
  assert.equal(fs.existsSync(SOURCE_RUN), true);
  assert.equal(fs.existsSync(BUILT_RUN), true);
});

test("the public CLI router is authored in TypeScript as the direct package bin", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/app/cli.mjs"), "utf8");
  assert.match(runtime, /^#!\/usr\/bin\/env bun\n/);
  assert.match(runtime, /\b(spawn|routes|commandHelp)\b/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);

  const source = fs.readFileSync(SOURCE_CLI, "utf8");
  assert.match(source, /const routes:/);
  assert.match(source, /child\.kill\(signal\)/);
  assert.match(source, /process\.exit\(signal === "SIGINT" \? 130/);
});

test("a clean shell build emits loadable artifacts from repository TypeScript sources", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-clean-build-"));
  try {
    const outDir = path.join(temp, "dist");
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of REMOVED_LAYOUT_MODULES) fs.writeFileSync(path.join(outDir, `${name}.mjs`), "stale");
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/build.mjs"), "--out-dir", outDir],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const rootLayout = await import(pathToFileURL(path.join(outDir, "platform/root-layout.mjs")).href);
    const processState = await import(pathToFileURL(path.join(outDir, "platform/process-state.mjs")).href);
    const messagePolicy = await import(pathToFileURL(path.join(outDir, "feishu/message-policy.mjs")).href);
    const agentStateStore = await import(pathToFileURL(path.join(outDir, "agent/agent-state-store.mjs")).href);
    const workspaceService = await import(pathToFileURL(path.join(outDir, "platform/workspace-service.mjs")).href);
    const config = require(path.join(outDir, "platform/config.cjs"));
    assert.equal(typeof rootLayout.planRootLayout, "function");
    assert.equal(typeof processState.acquireProcessLock, "function");
    assert.equal(typeof processState.readOwnedProcessRecord, "function");
    assert.equal(typeof messagePolicy.decideWake, "function");
    assert.equal(typeof require(path.join(outDir, "feishu/message-policy.cjs")).createMessageEnvelope, "function");
    assert.equal(typeof agentStateStore.createAgentStateStore, "function");
    assert.equal(typeof require(path.join(outDir, "agent/agent-state-store.cjs")).createAgentStateStore, "function");
    assert.deepEqual(Object.keys(rootLayout).sort(), ["TargetRootLayout", "planRootLayout", "resolveConfigDir"]);
    for (const name of REMOVED_LAYOUT_MODULES) {
      assert.equal(fs.existsSync(path.join(outDir, `${name}.mjs`)), false, `${name} must not survive a clean build`);
    }
    assert.equal(typeof workspaceService.reconcileAgentWorkspace, "function");
    assert.equal(typeof config.normalizeConfig, "function");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a compile failure preserves the prior complete dist byte-for-byte", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-build-failure-preserves-dist-"));
  try {
    const sourceDir = path.join(temp, "src");
    const outDir = path.join(temp, "dist");
    const buildTmpDir = path.join(temp, "controlled-tmp");
    fs.mkdirSync(buildTmpDir);
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temp, "node_modules"), "dir");
    fs.cpSync(path.join(ROOT, "src"), sourceDir, { recursive: true });
    const buildArgs = [SHELL_BUILDER, "--src-dir", sourceDir, "--out-dir", outDir];
    const buildEnv = { ...process.env, TMPDIR: buildTmpDir, TMP: buildTmpDir, TEMP: buildTmpDir };
    const initial = spawnSync(process.execPath, buildArgs, { cwd: ROOT, encoding: "utf8", env: buildEnv });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    assert.deepEqual(fs.readdirSync(buildTmpDir), [], "successful fixture build must clean its controlled staging root");
    const snapshot = () => {
      const files = [];
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else files.push({
            name: path.relative(outDir, file),
            bytes: fs.readFileSync(file).toString("base64"),
            mode: fs.statSync(file).mode & 0o777,
          });
        }
      };
      visit(outDir);
      return files;
    };
    const before = snapshot();
    assert.equal(before.length, countFiles(path.join(ROOT, "dist")), "successful fixture build must contain the complete shell and dashboard graph");

    fs.writeFileSync(path.join(sourceDir, "compile-failure.ts"), "const mustBeString: string = 42;\nexport { mustBeString };\n");
    const failed = spawnSync(process.execPath, buildArgs, { cwd: ROOT, encoding: "utf8", env: buildEnv });
    assert.notEqual(failed.status, 0, "injected TypeScript error must fail the build");
    assert.match(failed.stderr + failed.stdout, /Type 'number' is not assignable to type 'string'/);
    assert.deepEqual(snapshot(), before, "failed compile must leave every prior artifact and mode unchanged");
    assert.deepEqual(
      fs.readdirSync(buildTmpDir).filter((name) => name.startsWith("larkin-build-")),
      [],
      "failed compile must remove its controlled larkin-build staging directory",
    );
    assert.deepEqual(
      fs.readdirSync(temp).filter((name) => /^\.dist\./.test(name)),
      [],
      "failed compile must not leak staging or backup directories",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 15_000);

test("a publish rename failure restores the prior complete dist and cleans staging", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-publish-rename-failure-"));
  try {
    const sourceDir = path.join(temp, "src");
    const outDir = path.join(temp, "dist");
    const buildTmpDir = path.join(temp, "controlled-tmp");
    const preload = path.join(temp, "rename-fault.cjs");
    fs.mkdirSync(buildTmpDir);
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temp, "node_modules"), "dir");
    fs.cpSync(path.join(ROOT, "src"), sourceDir, { recursive: true });
    fs.writeFileSync(preload, `
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const originalRenameSync = fs.renameSync;
const targetOut = path.resolve(process.env.LARKIN_RENAME_FAULT_OUT);
let injected = false;
fs.renameSync = function renameSyncWithPublishFault(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  if (!injected
      && destinationPath === targetOut
      && /^\\.dist\\.\\d+\\.next$/.test(path.basename(sourcePath))) {
    const backup = path.join(path.dirname(targetOut), \`.\${path.basename(targetOut)}.\${process.pid}.previous\`);
    if (!fs.existsSync(backup)) throw new Error("publish rename reached before active output backup");
    injected = true;
    throw new Error("injected outputStage-to-OUT rename failure");
  }
  return originalRenameSync.apply(this, arguments);
};
syncBuiltinESMExports();
`);

    const buildArgs = [SHELL_BUILDER, "--src-dir", sourceDir, "--out-dir", outDir];
    const buildEnv = { ...process.env, TMPDIR: buildTmpDir, TMP: buildTmpDir, TEMP: buildTmpDir };
    const initial = spawnSync(process.execPath, buildArgs, { cwd: ROOT, encoding: "utf8", env: buildEnv });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    assert.deepEqual(fs.readdirSync(buildTmpDir), [], "successful fixture build must clean its controlled staging root");

    const snapshot = () => {
      const files = [];
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(file);
          else files.push({
            name: path.relative(outDir, file),
            bytes: fs.readFileSync(file).toString("base64"),
            mode: fs.statSync(file).mode & 0o777,
          });
        }
      };
      visit(outDir);
      return files;
    };
    const before = snapshot();
    assert.equal(before.length, countFiles(path.join(ROOT, "dist")), "successful fixture build must contain the complete shell and dashboard graph");

    const failed = spawnSync(process.execPath, ["--preload", preload, ...buildArgs], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...buildEnv, LARKIN_RENAME_FAULT_OUT: outDir },
    });
    assert.notEqual(failed.status, 0, "injected publish rename error must fail the build");
    assert.match(failed.stderr + failed.stdout, /injected outputStage-to-OUT rename failure/);
    assert.deepEqual(snapshot(), before, "failed publish must restore every prior artifact and mode unchanged");
    assert.deepEqual(
      fs.readdirSync(buildTmpDir).filter((name) => name.startsWith("larkin-build-")),
      [],
      "failed publish must remove its controlled larkin-build staging directory",
    );
    assert.deepEqual(
      fs.readdirSync(temp).filter((name) => /^\.dist\./.test(name)),
      [],
      "failed publish must not leak outputStage or backup directories",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 15_000);

test("target RootLayout plans non-overlapping workspace and state trees without touching disk", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-phase1-root-layout-"));
  try {
    const { planRootLayout, resolveConfigDir, TargetRootLayout } = await loadRootLayout();
    const before = fs.readdirSync(temp);
    const layout = planRootLayout({ root: temp, agentId: "cli_phase1" });

    assert.equal(layout.root, path.resolve(temp));
    assert.equal(layout.workspaceDir, path.join(path.resolve(temp), "agents", "cli_phase1"));
    assert.equal(layout.stateDir, path.join(path.resolve(temp), "state", "agents", "cli_phase1"));
    assert.notEqual(layout.workspaceDir, layout.stateDir);
    assert.equal(path.relative(layout.workspaceDir, layout.stateDir).startsWith(".."), true);
    assert.equal(path.relative(layout.stateDir, layout.workspaceDir).startsWith(".."), true);
    assert.deepEqual(fs.readdirSync(temp), before, "planning a target layout must not create directories");
    assert.equal(resolveConfigDir({ LARKIN_CONFIG_DIR: path.join(temp, "configured", "..") }, "/unused"), path.resolve(temp));
    assert.equal(resolveConfigDir({}, temp), path.join(temp, ".larkin"));
    const target = TargetRootLayout.fromConfigDir(temp);
    assert.equal(target.configFile, path.join(path.resolve(temp), "config.json"));
    assert.equal(target.daemonStatusFile, path.join(path.resolve(temp), "daemon-status.json"));
    assert.equal(target.dashboardStatusFile, path.join(path.resolve(temp), "dashboard-status.json"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("target RootLayout rejects Agent IDs that can escape their assigned subtree", async () => {
  const { planRootLayout } = await loadRootLayout();
  for (const agentId of ["../escape", "nested/agent", "nested\\agent", "/absolute", "", ".", "..", "profile", "cli_has-dash", "cli_has_dot"]) {
    assert.throws(
      () => planRootLayout({ root: path.join(os.tmpdir(), "larkin-phase1-never-write"), agentId }),
      /agent|id|path|invalid|escape/i,
      `unsafe agentId must be rejected: ${JSON.stringify(agentId)}`,
    );
  }
});

test("every authored source is covered by either the shell or Vite build graph", () => {
  const srcDir = path.join(ROOT, "src");
  const distDir = path.join(ROOT, "dist");
  const relativeFiles = (root) => {
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else files.push(path.relative(root, file));
      }
    };
    visit(root);
    return files;
  };
  const sources = relativeFiles(srcDir).filter((name) => /\.(?:ts|cts)$/.test(name)
    && !name.endsWith(".d.ts")
    && !name.startsWith(`dashboard${path.sep}web${path.sep}`));
  assert.ok(sources.length > 0, "authored shell sources must exist");
  const dist = new Set(relativeFiles(distDir));
  const uncovered = sources.filter((source) => {
    const name = source.replace(/\.(?:ts|cts)$/, "");
    return !dist.has(`${name}.mjs`) && !dist.has(`${name}.cjs`);
  });
  assert.deepEqual(uncovered, [], `authored sources missing from build output: ${uncovered.join(", ")}`);
  assert.equal(dist.has(path.join("dashboard", "web", "assets", "dashboard.js")), true,
    "Vite-managed dashboard TypeScript must produce the browser JavaScript bundle");
  assert.equal(dist.has(path.join("dashboard", "web", "assets", "dashboard.css")), true,
    "Vite-managed dashboard styles must produce the browser stylesheet");
});

test("CJS closure follows side-effect imports across product domains", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-build-side-effect-import-"));
  try {
    const sourceDir = path.join(temp, "src");
    const outDir = path.join(temp, "dist");
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temp, "node_modules"), "dir");
    fs.cpSync(path.join(ROOT, "src"), sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "platform", "side-effect-helper.ts"), "export const sideEffectClosureLoaded = true;\n");
    const hostShell = path.join(sourceDir, "feishu", "host-shell.ts");
    fs.writeFileSync(hostShell, `import "../platform/side-effect-helper.js";\n${fs.readFileSync(hostShell, "utf8")}`);
    const result = spawnSync(process.execPath, [SHELL_BUILDER, "--src-dir", sourceDir, "--out-dir", outDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(path.join(outDir, "platform", "side-effect-helper.cjs")), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("module specifier graph ignores comments and data strings while following .cts dependencies", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-build-ast-specifiers-"));
  try {
    const sourceDir = path.join(temp, "src");
    const outDir = path.join(temp, "dist");
    fs.writeFileSync(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temp, "node_modules"), "dir");
    fs.cpSync(path.join(ROOT, "src"), sourceDir, { recursive: true });
    const platformDir = path.join(sourceDir, "platform");
    fs.writeFileSync(path.join(platformDir, "exported-helper.ts"), "export const exported = true;\n");
    fs.writeFileSync(path.join(platformDir, "dynamic-helper.ts"), "export const dynamic = true;\n");
    fs.writeFileSync(path.join(platformDir, "required-helper.ts"), "export const required = true;\n");
    fs.writeFileSync(path.join(platformDir, "cts-helper.ts"), [
      'export { exported } from "./exported-helper.js";',
      'export const interpolated = `before ${"dynamic import"} after`;',
      'export const loadDynamic = () => import("./dynamic-helper.js");',
      'export const required = require("./required-helper.js");',
      'export const payload = "../platform/payload.js";',
      "",
    ].join("\n"));
    const processInspect = path.join(platformDir, "process-inspect.cts");
    const authored = fs.readFileSync(processInspect, "utf8");
    fs.writeFileSync(processInspect, authored.replace(
      'import { spawnSync } from "node:child_process";',
      'import { spawnSync } from "node:child_process";\nrequire("./cts-helper.js");\n// import "./comment-only-missing.js";',
    ));

    const result = spawnSync(process.execPath, [SHELL_BUILDER, "--src-dir", sourceDir, "--out-dir", outDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of ["cts-helper.cjs", "exported-helper.cjs", "dynamic-helper.cjs", "required-helper.cjs"]) {
      assert.equal(fs.existsSync(path.join(outDir, "platform", file)), true, `CJS closure missing ${file}`);
    }
    const processRuntime = fs.readFileSync(path.join(outDir, "platform", "process-inspect.cjs"), "utf8");
    assert.match(processRuntime, /require\(["']\.\/cts-helper\.cjs["']\)/);
    const helperRuntime = fs.readFileSync(path.join(outDir, "platform", "cts-helper.cjs"), "utf8");
    assert.match(helperRuntime, /["']\.\.\/platform\/payload\.js["']/);
    assert.doesNotMatch(helperRuntime, /payload\.cjs/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation and code comments do not advertise pre-cutover paths", () => {
  const documentation = ["README.md", "CONTRIBUTING.md", "SECURITY.md"]
    .map((relative) => path.join(ROOT, relative));
  const code = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) documentation.push(absolute);
      else if (entry.isFile() && /\.(?:[cm]?js|[cm]?ts)$/.test(entry.name)) code.push(absolute);
    }
  };
  visit(path.join(ROOT, "src"));
  visit(path.join(ROOT, "scripts"));
  visit(path.join(ROOT, "test"));

  const sourceBasenames = fs.readdirSync(path.join(ROOT, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => fs.readdirSync(path.join(ROOT, "src", entry.name)))
    .filter((name) => /\.(?:ts|cts)$/.test(name));
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flatSource = new RegExp(`\\bsrc/(?:${sourceBasenames.map(escapePattern).join("|")})\\b`);
  const flatDist = new RegExp(`\\bdist/(?:${sourceBasenames.map((name) => escapePattern(name.replace(/\.(?:ts|cts)$/, ""))).join("|")})\\.(?:mjs|cjs)\\b`);
  const stale = [
    /\bfork\/feishu\b/,
    /\bpackages\/larkin-shell\b/,
    /\btest\/integration\/(?:dashboard-session|dashboard-workspace|dashboard-port-fallback)\.test\.mjs\b/,
    flatSource,
    flatDist,
  ];
  const violations = [];
  for (const file of documentation) {
    const text = fs.readFileSync(file, "utf8");
    if (stale.some((pattern) => pattern.test(text))) violations.push(path.relative(ROOT, file));
  }
  for (const file of code) {
    const comments = fs.readFileSync(file, "utf8").split("\n")
      .filter((line) => /^\s*(?:\/\/|\/\*|\*)/.test(line)).join("\n");
    if (stale.some((pattern) => pattern.test(comments))) violations.push(path.relative(ROOT, file));
  }
  assert.deepEqual(violations, [], `pre-cutover paths remain in docs/comments: ${violations.join(", ")}`);
});

test("Phase 2 migration island is absent from authored source and built output", () => {
  for (const name of REMOVED_LAYOUT_MODULES) {
    assert.equal(fs.existsSync(path.join(ROOT, "src", `${name}.ts`)), false, `${name}.ts`);
    assert.equal(fs.existsSync(path.join(ROOT, "dist", `${name}.mjs`)), false, `${name}.mjs`);
  }
});
