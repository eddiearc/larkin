// Opt-in, read-only grant verification. Does not authorize apps or send messages.
// LARKIN_RUN_LARK_SETUP_SCOPE_GRANTS=1 LARKIN_AGENT_ID=<existing-app-id> bun test test/live/lark-setup-scope-grants-live.test.mjs
import path from "node:path";
import { loadValidatedBotCredential } from "../../dist/setup/run-credential-preflight.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { loadConfig, selectAgent } from "../../dist/platform/config.mjs";
import { managedOfficialLarkCli } from "../../dist/app/agent-lark-cli-workspace.mjs";
import { reconcileTenantScopes } from "../../src/setup/tenant-scope-grant.ts";

const enabled = process.env.LARKIN_RUN_LARK_SETUP_SCOPE_GRANTS === "1";
test.skipIf(!enabled)("real selected Lark bot has authoritative required tenant grant", { timeout: 40_000 }, () => {
  assert.ok(process.env.LARKIN_AGENT_ID, "explicit existing LARKIN_AGENT_ID is required");
  const { config } = loadConfig(process.env);
  const agent = selectAgent(config, process.env);
  assert.equal(loadValidatedBotCredential(path.join(config.larkinHome, "bots"), agent.feishuAppId).tenant, "lark");
  const managed = managedOfficialLarkCli(agent, process.env);
  const result = spawnSync(managed.command.command,
    [...managed.command.argsPrefix, "api", "GET", "/open-apis/application/v6/scopes", "--as", "bot"],
    { env: managed.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, "managed bot scope API request failed; inspect privately");
  const grants = reconcileTenantScopes(JSON.parse(result.stdout), ["im:message.group_msg"]);
  assert.equal(grants.verified, true, "invalid authoritative grant response");
  assert.deepEqual(grants.missingRequired, []);
  // Passing proves this grant only, not addons application, callbacks or message delivery.
});
