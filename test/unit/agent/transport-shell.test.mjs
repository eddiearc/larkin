import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const helpers = require(path.join(ROOT, "dist/agent/transport-shell.cjs"));

test("transport target mapping preserves exact and legacy base lookup semantics", () => {
  const map = {
    "dm:@person": "oc_dm",
    "dm:@person:topic": "oc_exact_topic",
    "#channel": "oc_channel",
  };
  assert.equal(helpers.resolveMappedChatId(map, "dm:@person:topic"), "oc_exact_topic");
  assert.equal(helpers.resolveMappedChatId(map, "dm:@person:missing"), "oc_dm");
  assert.equal(helpers.resolveMappedChatId(map, "#channel:missing"), "");
  assert.equal(helpers.resolveMappedChatId(map, null), "");
});

test("conversation excerpts redact credentials, normalize whitespace, and remain bounded", () => {
  assert.equal(
    helpers.safeConversationExcerpt(" hello\n token=abc123; sk-abcdefghijklmnop "),
    "hello token=[已隐藏]; [已隐藏凭证]",
  );
  assert.equal(helpers.safeConversationExcerpt("abcdef", 4), "abc…");
});

test("content classification keeps ordinary text plain and recognizes supported markdown", () => {
  for (const plain of ["hello", "5*3", "path#anchor", "@someone hello"]) {
    assert.equal(helpers.looksLikeMarkdown(plain), false, plain);
  }
  for (const markdown of ["# Title", "**bold**", "- item", "`code`", "> quote", "[x](https://example.com)"]) {
    assert.equal(helpers.looksLikeMarkdown(markdown), true, markdown);
  }
  assert.equal(helpers.isImageMime("image/png"), true);
  assert.equal(helpers.isImageMime("application/pdf"), false);
});

test("the production transport consumes the built helper module without moving request routing", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "dist/agent/agent-transport.cjs"), "utf8");
  const dispatcher = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  const context = fs.readFileSync(path.join(ROOT, "src/agent/transport-business-context.ts"), "utf8");
  assert.match(runtime, /transport-business-context\.cjs/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  assert.match(dispatcher, /from ["']\.\/transport-business-context\.js["']/);
  assert.match(context, /from ["']\.\/transport-shell\.js["']/);
  assert.match(dispatcher, /request: \(input: AgentTransportInput\) => handle\(input\)/);
  assert.match(dispatcher, /globalThis\.__LARKIN_AGENT_TRANSPORT/);
});
