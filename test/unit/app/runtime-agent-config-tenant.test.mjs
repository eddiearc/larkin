import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = await import(pathToFileURL(path.join(ROOT, "dist/app/runtime-agent-config.mjs")).href);

function writeAgent(root, { appId, tenant }) {
  fs.mkdirSync(path.join(root, "bots"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "bots", `${appId}.json`), `${JSON.stringify({
    appId, appSecret: "fixture-secret", tenant,
  })}\n`, { mode: 0o600 });
  return {
    name: appId,
    agentId: appId,
    feishuAppId: appId,
    feishuProfile: appId,
    runtime: "codex",
    model: "gpt",
    workspaceDir: path.join(root, "agents", appId),
    stateDir: path.join(root, "state", "agents", appId),
    larkConfigDir: path.join(root, "state", "agents", appId, "lark-cli-config"),
  };
}

test("hydrateRuntimeAgent and sourceProjection stay tenant-correct", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-tenant-"));
  try {
    const larkAgent = writeAgent(temp, { appId: "cli_runtimeLarkA1", tenant: "lark" });
    const hydratedLark = runtime.hydrateRuntimeAgent(temp, larkAgent);
    assert.equal(hydratedLark.feishuDomain, "https://open.larksuite.com");
    const larkProjection = JSON.stringify(runtime.sourceProjection(hydratedLark, { LARKIN_CONFIG_DIR: temp }));
    assert.match(larkProjection, /"tenant":"lark"/);
    assert.match(larkProjection, /open\.larksuite\.com|lark/);
    assert.doesNotMatch(larkProjection, /feishu\.cn/);

    const feishuAgent = writeAgent(temp, { appId: "cli_runtimeFeishuB2", tenant: "feishu" });
    const hydratedFeishu = runtime.hydrateRuntimeAgent(temp, feishuAgent);
    assert.equal(hydratedFeishu.feishuDomain, "https://open.feishu.cn");
    const feishuProjection = JSON.stringify(runtime.sourceProjection(hydratedFeishu, { LARKIN_CONFIG_DIR: temp }));
    assert.match(feishuProjection, /"tenant":"feishu"/);
    assert.doesNotMatch(feishuProjection, /larksuite\.com/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
