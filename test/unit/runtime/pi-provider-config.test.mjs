import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PI_PROVIDER_PRESETS,
  piAgentDirectory,
  stageBuiltinPiProvider,
  validateBuiltinPiProviderSelection,
  validatePiBaseUrl,
} from "../../../dist/runtime/pi-provider-config.mjs";

test("Pi provider presets keep the requested setup order and audited official endpoints", () => {
  assert.deepEqual(PI_PROVIDER_PRESETS.map((item) => item.id), [
    "deepseek", "kimi", "minimax", "zhipu", "openai", "anthropic", "gemini", "groq",
    "cerebras", "xai", "fireworks", "together", "mistral", "openrouter", "kimi-coding", "qwen-cn", "opencode-go",
  ]);
  assert.deepEqual(PI_PROVIDER_PRESETS.map((item) => item.baseUrl), [
    "https://api.deepseek.com",
    "https://api.moonshot.cn/v1",
    "https://api.minimaxi.com/anthropic",
    "https://open.bigmodel.cn/api/coding/paas/v4",
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "https://generativelanguage.googleapis.com/v1beta",
    "https://api.groq.com/openai/v1",
    "https://api.cerebras.ai/v1",
    "https://api.x.ai/v1",
    "https://api.fireworks.ai/inference",
    "https://api.together.ai/v1",
    "https://api.mistral.ai",
    "https://openrouter.ai/api/v1",
    "https://api.kimi.com/coding",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "https://opencode.ai/zen/go/v1",
  ]);
});

test("custom Pi endpoint validation rejects credentials, unsafe schemes, API leaf paths, and unsafe models", () => {
  assert.equal(validatePiBaseUrl("https://gateway.example/v1/"), "https://gateway.example/v1");
  assert.equal(validatePiBaseUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  for (const value of [
    "http://gateway.example/v1",
    "https://key@gateway.example/v1",
    "file:///tmp/provider",
    "https://gateway.example/v1/chat/completions",
    "https://gateway.example/v1?api_key=secret",
  ]) assert.throws(() => validatePiBaseUrl(value));
  assert.throws(() => validateBuiltinPiProviderSelection({
    distribution: "builtin", preset: "custom", baseUrl: "https://gateway.example/v1",
    apiKey: "secret", model: "bad model",
  }));
});

test("Pi credential transaction uses 0700/0600, preserves unrelated providers, and keeps keys out of models.json", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-provider-"));
  try {
    fs.chmodSync(temp, 0o700);
    const directory = piAgentDirectory(temp, "cli_providerA1");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ unrelated: { type: "api_key", key: "keep-me" } }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "models.json"), JSON.stringify({ providers: { unrelated: { baseUrl: "https://keep.example/v1" } } }), { mode: 0o600 });
    const transaction = stageBuiltinPiProvider(temp, "cli_providerA1", {
      distribution: "builtin", preset: "custom", baseUrl: "https://gateway.example/v1",
      apiKey: "custom-super-secret", model: "acme/code-model",
    });
    const auth = JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8"));
    const modelsRaw = fs.readFileSync(path.join(directory, "models.json"), "utf8");
    const models = JSON.parse(modelsRaw);
    assert.equal(auth.unrelated.key, "keep-me");
    assert.equal(auth["larkin-custom"].key, "custom-super-secret");
    assert.equal(models.providers.unrelated.baseUrl, "https://keep.example/v1");
    assert.equal(models.providers["larkin-custom"].models[0].id, "acme/code-model");
    assert.doesNotMatch(modelsRaw, /custom-super-secret/);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "auth.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(directory, "models.json")).mode & 0o777, 0o600);
    transaction.rollback();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8")), { unrelated: { type: "api_key", key: "keep-me" } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "models.json"), "utf8")), { providers: { unrelated: { baseUrl: "https://keep.example/v1" } } });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("switching a preset updates only its auth entry and never removes custom models", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-preset-"));
  try {
    fs.chmodSync(temp, 0o700);
    const custom = stageBuiltinPiProvider(temp, "cli_providerB2", {
      distribution: "builtin", preset: "custom", baseUrl: "https://gateway.example/v1",
      apiKey: "custom-key", model: "acme-code",
    });
    custom.commit();
    const preset = stageBuiltinPiProvider(temp, "cli_providerB2", {
      distribution: "builtin", preset: "deepseek", apiKey: "deepseek-key", model: "deepseek-v4-pro",
    });
    preset.commit();
    const directory = piAgentDirectory(temp, "cli_providerB2");
    const auth = JSON.parse(fs.readFileSync(path.join(directory, "auth.json"), "utf8"));
    const models = JSON.parse(fs.readFileSync(path.join(directory, "models.json"), "utf8"));
    assert.equal(auth["larkin-custom"].key, "custom-key");
    assert.equal(auth.deepseek.key, "deepseek-key");
    assert.equal(models.providers["larkin-custom"].models[0].id, "acme-code");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
