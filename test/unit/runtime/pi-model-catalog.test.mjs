import assert from "node:assert/strict";
import fs from "node:fs";
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
  assert.doesNotMatch(inlineExtensions, /@tintinweb\/pi-subagents\/dist\/index\.js/);
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
