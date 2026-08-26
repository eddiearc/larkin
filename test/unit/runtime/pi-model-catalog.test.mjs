import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  discoverPiModelCatalog,
  findExactPiModel,
  supportedPiThinkingLevels,
} from "../../../dist/runtime/pi-model-catalog.mjs";
import { applyPiPackageDirForChild, piChildDistributionFromOverrides } from "../../../dist/runtime/builtin-pi-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);

const models = [
  { provider: "plain", id: "chat", name: "Chat", reasoning: false, contextWindow: 32_000 },
  { provider: "reason", id: "pro", name: "Pro", reasoning: true, contextWindow: 200_000, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "reason", id: "small", name: "Small", reasoning: true, thinkingLevelMap: { off: null } },
];

class FakePi extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  stdin = { destroyed: false, write: (line, callback) => {
    const request = JSON.parse(line);
    const data = request.type === "get_available_models"
      ? { models: this.models }
      : { model: this.model, thinkingLevel: this.thinkingLevel };
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data })}\n`));
    callback?.(); return true;
  } };
  constructor(modelsValue, model, thinkingLevel = "off") { super(); this.models = modelsValue; this.model = model; this.thinkingLevel = thinkingLevel; }
  kill(signal) { queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

const rpcCatalog = (available, model, thinkingLevel = "off") => discoverPiModelCatalog({
  cwd: "/tmp/pi-catalog", spawn: () => new FakePi(available, model, thinkingLevel),
});

test("Pi catalog uses canonical authenticated models and structured RPC default resolution", async () => {
  const catalog = await rpcCatalog(models, models[1], "high");
  assert.deepEqual(catalog.models.map((model) => model.id), ["plain/chat", "reason/pro", "reason/small"]);
  assert.deepEqual(catalog.models.map((model) => model.contextWindow), [32_000, 200_000, undefined]);
  assert.equal(catalog.effectiveModel, "reason/pro");
  assert.equal(catalog.effectiveThinkingLevel, "high");
  assert.equal(catalog.defaultSource, "settings");
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ["off"]);
  assert.deepEqual(catalog.models[1].supportedReasoningEfforts, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(catalog.models[2].supportedReasoningEfforts, ["minimal", "low", "medium", "high"]);
});

test("Pi exact resolver rejects bare, ambiguous and missing model references", () => {
  assert.equal(findExactPiModel("reason/pro", models), models[1]);
  assert.equal(findExactPiModel("pro", models), undefined);
  assert.equal(findExactPiModel("default", models), undefined);
  assert.equal(findExactPiModel("reason/missing", models), undefined);
});

test("Pi catalog fails closed when authentication exposes no available models", async () => {
  await assert.rejects(() => rpcCatalog([], { provider: "unknown", id: "unknown" }),
  /no authenticated available models.*will not create a fallback session/i);
});

test("Pi catalog refuses an RPC default that is absent from the authenticated catalog", async () => {
  await assert.rejects(() => rpcCatalog([models[1]], { provider: "removed", id: "stale" }, "high"),
    /official default resolution returned an unavailable model.*refusing implicit fallback/i);
});

test("Pi catalog publishes the official clamped thinking default instead of raw settings", async () => {
  const catalog = await rpcCatalog([models[0]], models[0], "off");
  assert.equal(catalog.effectiveThinkingLevel, "off");
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ["off"]);
  assert.equal(catalog.models[0].defaultReasoningEffort, "off");
});

test("Pi thinking levels follow official reasoning metadata without Codex ultra", () => {
  assert.deepEqual(supportedPiThinkingLevels(models[0]), ["off"]);
  assert.equal(supportedPiThinkingLevels(models[1]).includes("max"), true);
  assert.equal(supportedPiThinkingLevels(models[1]).includes("ultra"), false);
});

test("child Pi distribution ignores host builtin unless an override says so", () => {
  assert.equal(piChildDistributionFromOverrides(undefined), "external");
  assert.equal(piChildDistributionFromOverrides({ LARKIN_PI_DISTRIBUTION: "builtin" }), "builtin");
  assert.equal(piChildDistributionFromOverrides({ LARKIN_PI_DISTRIBUTION: "builtin" }, { LARKIN_PI_DISTRIBUTION: "external" }), "external");
});

test("external Pi child env drops inherited builtin PI_PACKAGE_DIR", () => {
  const env = applyPiPackageDirForChild({
    PI_PACKAGE_DIR: "/tmp/agent/.larkin-official-pi-package",
    PI_CODING_AGENT_DIR: "/tmp/agent",
    LARKIN_PI_DISTRIBUTION: "external",
  });
  assert.equal(env.PI_PACKAGE_DIR, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/agent");
});

test("builtin Pi child env keeps PI_PACKAGE_DIR", () => {
  const packageDir = "/tmp/agent/.larkin-official-pi-package";
  const env = applyPiPackageDirForChild({
    PI_PACKAGE_DIR: packageDir,
    LARKIN_PI_DISTRIBUTION: "builtin",
  }, "builtin");
  assert.equal(env.PI_PACKAGE_DIR, packageDir);
});

test("setup-style catalog env with host builtin + minimal PI_PACKAGE_DIR still strips the builtin dir", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue156-setup-"));
  const packageDir = path.join(root, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(packageDir, "theme"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), "{\"name\":\"fixture-builtin-pi\"}\n");
  fs.writeFileSync(path.join(packageDir, "theme", "dark.json"), "{}\n");
  try {
    let childEnv;
    const catalog = await discoverPiModelCatalog({
      cwd: root,
      env: {
        LARKIN_PI_DISTRIBUTION: "builtin",
        PI_PACKAGE_DIR: packageDir,
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
      },
      spawn: (_command, _args, options) => {
        childEnv = options.env;
        return new FakePi(models, models[0]);
      },
    });
    assert.equal(childEnv.PI_PACKAGE_DIR, undefined);
    assert.equal(catalog.effectiveModel, "plain/chat");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external env keeps a Nix-like package root and strips symlink/minimal/missing roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue156-roots-"));
  const nixDir = path.join(root, "nix", "store", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-pi-coding-agent-0.84.2");
  fs.mkdirSync(path.join(nixDir, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(nixDir, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  const minimal = path.join(root, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(minimal, "theme"), { recursive: true });
  fs.writeFileSync(path.join(minimal, "theme", "dark.json"), "{}\n");
  const aliasToMinimal = path.join(root, "alias-minimal");
  const aliasToNix = path.join(root, "alias-nix");
  fs.symlinkSync(minimal, aliasToMinimal);
  fs.symlinkSync(nixDir, aliasToNix);
  try {
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: nixDir }, "external").PI_PACKAGE_DIR, fs.realpathSync(nixDir));
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: aliasToNix }, "external").PI_PACKAGE_DIR, fs.realpathSync(nixDir));
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: minimal }, "external").PI_PACKAGE_DIR, undefined);
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: aliasToMinimal }, "external").PI_PACKAGE_DIR, undefined);
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: path.join(root, "missing") }, "external").PI_PACKAGE_DIR, undefined);
    const dirAsTheme = path.join(root, "dir-theme");
    fs.mkdirSync(path.join(dirAsTheme, "dist", "modes", "interactive", "theme", "dark.json"), { recursive: true });
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: dirAsTheme }, "external").PI_PACKAGE_DIR, undefined);
    const linkedThemeRoot = path.join(root, "linked-theme");
    const themeFile = path.join(root, "real-dark.json");
    fs.writeFileSync(themeFile, "{}\n");
    fs.mkdirSync(path.join(linkedThemeRoot, "dist", "modes", "interactive", "theme"), { recursive: true });
    fs.symlinkSync(themeFile, path.join(linkedThemeRoot, "dist", "modes", "interactive", "theme", "dark.json"));
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: linkedThemeRoot }, "external").PI_PACKAGE_DIR, fs.realpathSync(linkedThemeRoot));
    const brokenThemeRoot = path.join(root, "broken-theme");
    fs.mkdirSync(path.join(brokenThemeRoot, "dist", "modes", "interactive", "theme"), { recursive: true });
    fs.symlinkSync(path.join(root, "missing-dark.json"), path.join(brokenThemeRoot, "dist", "modes", "interactive", "theme", "dark.json"));
    assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: brokenThemeRoot }, "external").PI_PACKAGE_DIR, undefined);
    if (process.platform !== "win32") {
      const unread = path.join(root, "unread-root");
      fs.mkdirSync(path.join(unread, "dist", "modes", "interactive", "theme"), { recursive: true });
      const unreadTheme = path.join(unread, "dist", "modes", "interactive", "theme", "dark.json");
      fs.writeFileSync(unreadTheme, "{}\n", { mode: 0o000 });
      fs.chmodSync(unreadTheme, 0o000);
      assert.equal(applyPiPackageDirForChild({ PI_PACKAGE_DIR: unread }, "external").PI_PACKAGE_DIR, undefined);
      fs.chmodSync(unreadTheme, 0o644);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit external PI_PACKAGE_DIR is kept only when it is a real Node package root", () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue156-real-pkg-"));
  const realDir = path.join(realRoot, "pi-pkg");
  fs.mkdirSync(path.join(realDir, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(realDir, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  const builtinDir = path.join(realRoot, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(builtinDir, "theme"), { recursive: true });
  try {
    const kept = applyPiPackageDirForChild({ PI_PACKAGE_DIR: builtinDir }, {
      distribution: "external",
      explicitPackageDir: realDir,
    });
    assert.equal(kept.PI_PACKAGE_DIR, fs.realpathSync(realDir));
    const stripped = applyPiPackageDirForChild({ PI_PACKAGE_DIR: builtinDir }, {
      distribution: "external",
      explicitPackageDir: builtinDir,
    });
    assert.equal(stripped.PI_PACKAGE_DIR, undefined);
  } finally {
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});

test("external catalog discovery succeeds after builtin assets materialize without reading dist themes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue156-"));
  const packageDir = path.join(root, ".larkin-official-pi-package");
  const themeDir = path.join(packageDir, "theme");
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), "{\"name\":\"fixture-builtin-pi\"}\n");
  fs.writeFileSync(path.join(themeDir, "dark.json"), "{}\n");
  fs.writeFileSync(path.join(themeDir, "light.json"), "{}\n");
  const probe = path.join(root, "external-pi.mjs");
  fs.writeFileSync(probe, `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const packageDir = process.env.PI_PACKAGE_DIR;
if (packageDir) fs.readFileSync(path.join(packageDir, "dist/modes/interactive/theme/dark.json"));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const model = { provider: "plain", id: "chat", name: "Chat", reasoning: false, contextWindow: 32000 };
  const data = request.type === "get_available_models" ? { models: [model] } : { model, thinkingLevel: "off" };
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
});
`);
  try {
    const catalog = await discoverPiModelCatalog({
      cwd: root,
      command: process.execPath,
      commandArgs: [probe],
      env: { PI_PACKAGE_DIR: packageDir },
    });
    assert.equal(catalog.effectiveModel, "plain/chat");
    assert.equal(catalog.models[0].id, "plain/chat");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog cache distinguishes sanitized package roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue156-cache-"));
  const makePkg = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, "dist", "modes", "interactive", "theme"), { recursive: true });
    fs.writeFileSync(path.join(dir, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
    return dir;
  };
  const first = makePkg("one");
  const second = makePkg("two");
  const script = path.join(root, "pi.mjs");
  fs.writeFileSync(script, `
import path from "node:path";
import readline from "node:readline";
const id = path.basename(process.env.PI_PACKAGE_DIR || "missing");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  const model = { provider: "plain", id, name: id, reasoning: false, contextWindow: 32000 };
  const data = request.type === "get_available_models" ? { models: [model] } : { model, thinkingLevel: "off" };
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }) + "\\n");
});
`);
  try {
    const a = await discoverPiModelCatalog({
      cwd: root, command: process.execPath, commandArgs: [script], packageDir: first,
    });
    const b = await discoverPiModelCatalog({
      cwd: root, command: process.execPath, commandArgs: [script], packageDir: second,
    });
    assert.equal(a.effectiveModel, "plain/one");
    assert.equal(b.effectiveModel, "plain/two");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production graph pins official Pi and exposes it only through the shared RPC contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
  const adapter = fs.readFileSync(path.join(ROOT, "src/runtime/runtime-adapters.ts"), "utf8");
  const binaryEntry = fs.readFileSync(path.join(ROOT, "src/app/binary-entry.ts"), "utf8");
  const inlineExtensions = fs.readFileSync(path.join(ROOT, "src/runtime/pi-inline-extensions.ts"), "utf8");
  const bundledPi = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
  const rpcTypes = fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts"), "utf8");
  assert.equal(pkg.dependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(bundledPi.name, "@earendil-works/pi-coding-agent");
  assert.equal(bundledPi.version, "0.84.2");
  for (const dependency of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-client", "@earendil-works/pi-protocol", "@earendil-works/pi-tui"]) {
    assert.match(String(bundledPi.dependencies[dependency]), /^\^0\.84\.2$/);
  }
  assert.match(rpcTypes, /type: "prompt"/);
  assert.match(rpcTypes, /type: "get_state"/);
  assert.match(rpcTypes, /type: "compact"/);
  assert.match(rpcTypes, /type: "response"/);
  assert.match(rpcTypes, /success: true/);
  assert.equal(pkg.dependencies["@tintinweb/pi-subagents"], "0.14.3");
  assert.equal(pkg.dependencies["@mariozechner/pi-coding-agent"], undefined);
  assert.equal(pkg.packageManager, "bun@1.3.14");
  assert.equal(pkg.engines, undefined);
  assert.equal(pkg.scripts.preinstall, undefined);
  assert.match(lock, /@earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(adapter, /from\s+["'][^"']*pi-coding-agent/);
  assert.doesNotMatch(binaryEntry, /pi-coding-agent\/rpc-entry/);
  assert.match(binaryEntry, /main:\s*piMain/);
  assert.match(binaryEntry, /pi-ai\/bun-oauth/);
  assert.match(binaryEntry, /registerBunOAuthFlows\(\)/);
  assert.match(inlineExtensions, /bundledPiSubagentExtensionPath/);
  assert.match(inlineExtensions, /process\.env\.LARKIN_STANDALONE === ["']1["']/);
  assert.match(inlineExtensions, /import\(["']@tintinweb\/pi-subagents\/dist\/index\.js["']\)/);
  assert.match(inlineExtensions, /import\(pathToFileURL\(bundle\)\.href\)/);
  assert.match(adapter, /--mode["'],\s*["']rpc/);
  assert.doesNotMatch(adapter, /available\s*\[\s*0\s*\]/);
});

test("Bun preflight requires the exact pinned runtime", () => {
  const check = require("../../../dist/platform/check-bun-version.cjs");
  assert.equal(check.supported("1.3.14"), true);
  assert.equal(check.supported("1.3.13"), false);
  assert.equal(check.supported("1.4.0"), false);
  assert.throws(() => check.assertSupportedBun("1.3.13"), /requires Bun 1\.3\.14.*packageManager/i);
  for (const file of [
    "dist/app/cli.mjs", "dist/app/run.mjs", "dist/app/setup.mjs",
    "dist/app/agent-config.mjs", "dist/app/dashboard.mjs",
  ]) assert.match(fs.readFileSync(path.join(ROOT, file), "utf8"), /check-bun-version\.cjs/, `${file} must fail fast`);
  for (const file of [
    "src/app/run.ts", "src/app/setup.ts",
    "src/app/agent-config.ts", "src/app/dashboard.ts",
  ]) assert.match(fs.readFileSync(path.join(ROOT, file), "utf8"), /check-bun-version\.cjs/, `${file} source entry must fail fast`);
});
