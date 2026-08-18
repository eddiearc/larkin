#!/usr/bin/env bun
// Internal permission-update flow for an existing App-ID bot.

import fs from "node:fs";
import { spawnSync as systemSpawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerApp as channelRegisterApp } from "@larksuite/channel";
import { markSetupCapabilitiesRequested } from "../platform/callback-capability.js";
import * as larkinConfig from "../platform/config.js";
import { managedOfficialLarkCli } from "../app/agent-lark-cli-workspace.js";
import { loadValidatedBotCredential } from "./run-credential-preflight.js";
import { parseLarkinTenant, registerAppAccountsHost, type LarkinTenant } from "../feishu/platform-hosts.js";
// qrcode-terminal does not publish TypeScript declarations.
// @ts-expect-error bundled CommonJS dependency
import qrcodePackage from "qrcode-terminal";

interface AgentConfig {
  agentId: string;
}

interface HydratedConfig {
  larkinHome: string;
  activeAgent: string | null;
  agents: Record<string, AgentConfig>;
}

interface GrantOptions {
  source: string;
  appId: string;
  addons: { scopes: { tenant: string[] }; events: { items: { tenant: string[] } }; callbacks: { items: string[] } };
  domain?: string;
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange(info: { status: string }): void;
}

type RegisterApp = (options: GrantOptions) => Promise<{ client_id?: string } | null>;
const testFixture = process.env.LARKIN_TEST_GRANT_SCOPES_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.LARKIN_TEST_GRANT_SCOPES_MODULE)).href) as {
    registerApp?: RegisterApp;
    qrcode?: { generate(text: string, options: { small: boolean }): void };
    spawnSync?: typeof systemSpawnSync;
    managedOfficialCli?: typeof managedOfficialLarkCli;
  }
  : null;
const registerApp: RegisterApp = testFixture?.registerApp ?? channelRegisterApp as unknown as RegisterApp;
const qrcode = testFixture?.qrcode ?? qrcodePackage;
const spawnSync = testFixture?.spawnSync ?? systemSpawnSync;
const resolveManagedOfficialCli = testFixture?.managedOfficialCli ?? managedOfficialLarkCli;

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数值`);
  return value;
};
const { config } = larkinConfig.loadConfig(process.env);
const explicitAppId = flag("--app-id", "");
const explicitAgent = flag("--agent", "");
if (explicitAppId && explicitAgent && explicitAppId !== explicitAgent) throw new Error("--app-id 必须与 --agent 指向同一 Agent");
const selected = larkinConfig.selectAgent(config, (explicitAgent || explicitAppId)
  ? { LARKIN_AGENT_ID: explicitAgent || explicitAppId } : process.env);
const APP_ID = selected.agentId;
if (explicitAppId && explicitAppId !== selected.feishuAppId) throw new Error("--app-id 必须等于所选 Agent 的 App ID");
if (!/^cli_[A-Za-z0-9]+$/.test(APP_ID)) throw new Error(`无效飞书（Lark） App ID：${APP_ID}`);
const SEND_TO = flag("--send-to", "");
const explicitTenant = argv.includes("--tenant") ? flag("--tenant", "") : "";
if (argv.includes("--tenant") && !parseLarkinTenant(explicitTenant)) {
  throw new Error("--tenant 只支持 feishu 或 lark");
}
function storedCredentialTenant(): LarkinTenant {
  try {
    return loadValidatedBotCredential(path.join(config.larkinHome, "bots"), APP_ID).tenant;
  } catch {
    return "feishu";
  }
}
const TENANT = parseLarkinTenant(explicitTenant) ?? storedCredentialTenant();
const WAIT_MIN = Number(flag("--wait-min", "9"));
const URL_FILE = flag("--url-file", "");

const TENANT_SCOPES = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message:send_as_bot",
  "im:chat:readonly",
  "im:chat",
  "im:chat:create",
  "im:chat:update",
  "im:chat.group_info:readonly",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:chat:operate_as_owner",
  "im:resource",
  "application:application:self_manage",
  "contact:user.employee_id:readonly",
  "admin:app.visibility",
  "drive:drive",
  "docs:document.comment:read",
  "docs:document.comment:create",
];
const TENANT_EVENTS = ["drive.notice.comment_add_v1"];
const log = (...args: unknown[]): void => { process.stderr.write(`${args.join(" ")}\n`); };

function sendUrlToChat(url: string, minutes: number): void {
  if (!SEND_TO) return;
  const text = `🔐 larkin 给机器人【${APP_ID}】增补权限。\n请【应用 owner 本人】打开下面链接确认(约 ${minutes} 分钟内有效)，勾选并确认这些权限：\n${TENANT_SCOPES.join("、")}\n\n${url}\n\n确认后我会自动接上并重试读取。`;
  const managed = resolveManagedOfficialCli(selected, process.env);
  const result = spawnSync(managed.command.command, [...managed.command.argsPrefix, "im", "+messages-send", "--chat-id", SEND_TO, "--text", text, "--json"], {
    encoding: "utf8", env: managed.env,
  });
  log(result.status === 0 ? "[grant] 更新链接已发到飞书（Lark）群" : `[grant] 发链接失败: ${(result.stderr || "").trim().split("\n")[0]}`);
}

export async function main(): Promise<void> {
  log(`=== 给 bot ${APP_ID} 增补读取权限(registerApp 更新流) ===`);
  const timeout = setTimeout(() => {
    log(`[grant] ${WAIT_MIN} 分钟内未完成，退出。可重跑。`);
    process.exit(2);
  }, WAIT_MIN * 60 * 1000);
  const options: GrantOptions = {
    source: "larkin",
    appId: APP_ID,
    addons: {
      scopes: { tenant: TENANT_SCOPES },
      events: { items: { tenant: TENANT_EVENTS } },
      callbacks: { items: ["card.action.trigger"] },
    },
    onQRCodeReady: (info) => {
      const minutes = Math.max(1, Math.round(info.expireIn / 60));
      log("\n请用飞书（Lark）扫码或打开链接，确认给应用增补权限：\n");
      qrcode.generate(info.url, { small: true });
      log(`\n链接: ${info.url}\n有效期约 ${minutes} 分钟（⚠️ 需本进程保持轮询，否则 user_code 立即失效）\n`);
      if (URL_FILE) {
        try { fs.writeFileSync(URL_FILE, info.url); }
        catch (error) { log(`[grant] 写 url-file 失败: ${error instanceof Error ? error.message : String(error)}`); }
      }
      sendUrlToChat(info.url, minutes);
    },
    onStatusChange: (info) => log(`[grant] 状态: ${info.status}`),
    domain: registerAppAccountsHost(TENANT),
  };

  let result: { client_id?: string } | null;
  try { result = await registerApp(options); }
  catch (error) {
    clearTimeout(timeout);
    log(`[grant] 失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  clearTimeout(timeout);
  log(`\n✓ 权限增补已确认，appId=${result?.client_id || APP_ID}`);
  log(`  已请求增补: ${TENANT_SCOPES.join(", ")}`);
  log(`  已请求事件: ${TENANT_EVENTS.join(", ")}（仍需发布并用真实文档 @Bot 验证）`);
  try {
    markSetupCapabilitiesRequested(config.larkinHome, result?.client_id || APP_ID);
    log("  card.action.trigger 仍是 requested-unverified；请确认发布后执行 interaction callback-probe 并真实点击，验证前不会创建业务交互卡片。");
    log("  document comment capability=publish_or_event_unverified reason=publication_and_real_event_unverified；配置发布与真实事件到达均未验证，不声明生效。");
    log("  document comment reply scope=docs:document.comment:create requested-unverified；同时覆盖 in-thread reply 与 whole-document create_v2 fallback。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    log("  本机没有该 App 的 bot credential，无法记录 callback readiness；能力保持 missing，请先运行 larkin setup 后再执行 callback-probe。");
  }
  console.log(`GRANTED_APP_ID=${result?.client_id || APP_ID}`);
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    log(`[grant] 异常: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
