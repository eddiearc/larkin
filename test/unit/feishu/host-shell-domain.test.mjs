import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { createHostShell } = await import(pathToFileURL(path.join(ROOT, "dist/feishu/host-shell.mjs")).href);
const { requireOpenDomain } = await import(pathToFileURL(path.join(ROOT, "dist/feishu/platform-hosts.mjs")).href);

function agentConfig(root, id, domain) {
  return {
    agentId: id, name: id, runtime: "codex", model: "gpt", feishuAppId: id,
    feishuAppSecret: "fixture-secret", feishuProfile: id, feishuDomain: domain,
    workspaceDir: path.join(root, "agents", id), stateDir: path.join(root, "state", "agents", id),
    larkConfigDir: path.join(root, "lark-cli-config"),
  };
}

test("Lark agent createLarkChannel uses open.larksuite.com and never open.feishu.cn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-lark-domain-"));
  const agentId = "cli_hostLarkDomainA1";
  const captured = [];
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver() { throw new Error("not used"); },
    async stop() {},
    async shutdown() {},
  };
  const channelPackage = {
    createLarkChannel(options) {
      captured.push(options);
      return {
        botIdentity: { openId: "ou_lark", name: "Lark" },
        rawClient: null,
        dispatcher: { register() {} },
        on() {},
        async connect() {},
        async disconnect() {},
      };
    },
  };
  const agent = agentConfig(root, agentId, "https://open.larksuite.com");
  const host = createHostShell({
    env: {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-lark-domain",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0",
    },
    runtimeHost, channelPackage, eventSourceStartDelayMs: 0,
  });
  try {
    host.start();
    const deadline = Date.now() + 2_000;
    while (captured.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(captured.length > 0, true);
    assert.equal(captured[0].domain, "https://open.larksuite.com");
    assert.notEqual(captured[0].domain, "https://open.feishu.cn");
    assert.doesNotMatch(JSON.stringify(captured[0]), /feishu\.cn/);
  } finally {
    await host.shutdown("lark domain test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing feishuDomain throws and does not default to China", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-missing-domain-"));
  try {
    const agentId = "cli_hostMissingDomainA1";
    const agent = agentConfig(root, agentId, undefined);
    delete agent.feishuDomain;
    assert.throws(() => createHostShell({
      env: {
        LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-missing-domain",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
      },
      runtimeHost: {
        subscribe() { return () => {}; },
        async start() {}, async deliver() {}, async stop() {}, async shutdown() {},
      },
      channelPackage: {
        createLarkChannel() { throw new Error("createLarkChannel must not run without a domain"); },
      },
    }), /缺少有效 channel 凭证\/domain/);
    assert.throws(() => requireOpenDomain(undefined), /missing or invalid Open Platform domain/);
    assert.throws(() => requireOpenDomain(""), /missing or invalid Open Platform domain/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
