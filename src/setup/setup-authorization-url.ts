import { openPlatformHost, type LarkinTenant } from "../feishu/platform-hosts.js";

export interface OfficialCliSetupUrlInput {
  tenant: LarkinTenant;
  userCode: string;
  larkCliVersion: string;
}

// Official lark-cli presents /page/cli. node-sdk registerApp returns /page/launcher,
// which open.larksuite.com ack rejects with 10074 ("链接已失效") for Lark tenants.
export function officialCliSetupUrl(input: OfficialCliSetupUrlInput): string {
  const userCode = input.userCode.trim();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)) throw new Error("setup user_code 格式非法");
  const version = input.larkCliVersion.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("lark-cli version 格式非法");
  const url = new URL(`${openPlatformHost(input.tenant)}/page/cli`);
  url.searchParams.set("user_code", userCode);
  url.searchParams.set("lpv", version);
  url.searchParams.set("ocv", version);
  url.searchParams.set("from", "cli");
  return url.toString();
}

export function presentAuthorizationUrl(
  rawUrl: string,
  input: { tenant: LarkinTenant; larkCliVersion: string },
): string {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error("授权 URL 非法"); }
  const userCode = parsed.searchParams.get("user_code") || "";
  // Feishu China still authorizes on /page/launcher. Only International Lark
  // must leave launcher (open.larksuite.com ack 10074 / 链接已失效).
  if (input.tenant === "lark" && parsed.pathname === "/page/launcher") {
    if (!userCode) throw new Error("Lark 租户拒绝把 /page/launcher 交给浏览器");
    const presented = new URL(officialCliSetupUrl({ tenant: "lark", userCode, larkCliVersion: input.larkCliVersion }));
    // node-sdk registerApp encodes scopes/events/callbacks only on the landing URL
    // (`addons=`). Keep that payload when rewriting launcher → /page/cli so Lark
    // still requests the same Larkin addons Feishu already sends.
    const addons = parsed.searchParams.get("addons");
    if (addons) presented.searchParams.set("addons", addons);
    return presented.toString();
  }
  return parsed.toString();
}

export function authorizationUrlFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  const description = error && typeof error === "object" && "description" in error
    ? String((error as { description?: unknown }).description) : "";
  const detail = [code, description, message].filter(Boolean).join(": ");
  return `网页授权失败（${detail || "unknown"}）；未执行凭证同步、文件写入或 Agent 绑定。Lark 租户不要使用 /page/launcher（ack 10074 / 链接已失效），应走官方 lark-cli 的 /page/cli。`;
}
