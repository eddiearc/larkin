import assert from "node:assert/strict";
import { test } from "bun:test";
import { providerFinishReason } from "../../../src/runtime/provider-error-classifier.ts";

test("provider finish reasons are extracted from the allow-listed vocabulary", () => {
  assert.equal(providerFinishReason("Provider finish_reason: content_filter"), "content_filter");
  assert.equal(providerFinishReason("rawStopReason: CONTENT_FILTER"), "content_filter");
  assert.equal(providerFinishReason("finishReason=MAX_TOKENS"), "max_tokens");
  assert.equal(providerFinishReason('finish_reason: "safety"'), "safety");
});

test("provider finish reason extraction never echoes unvalidated Runtime text", () => {
  for (const value of [
    undefined,
    null,
    42,
    "",
    "raw asynchronous provider payload api_key=issue124-super-secret",
    "Authorization: Bearer sk-abcdefghijklmnopqrst",
    "finish_reason: super_secret_value",
    `finish_reason: ${"x".repeat(40)}`,
    `finish_reason: content_filter ${"z".repeat(9_000)}`,
  ]) {
    assert.equal(providerFinishReason(value), null, JSON.stringify(value));
  }
});
