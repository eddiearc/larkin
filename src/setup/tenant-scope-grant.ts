import { openPlatformHost, type LarkinTenant } from "../feishu/platform-hosts.js";

/** Tenant scopes the freshness gate needs on the Bot application. */
export const FRESHNESS_REQUIRED_TENANT_SCOPES = ["im:message.group_msg"] as const;

interface ScopeRow {
  scope_name?: unknown;
  grant_status?: unknown;
  scope_type?: unknown;
}

function asRows(payload: unknown): ScopeRow[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as { data?: { scopes?: unknown }; scopes?: unknown };
  const raw = Array.isArray(root.data?.scopes) ? root.data.scopes
    : Array.isArray(root.scopes) ? root.scopes
    : [];
  return raw.filter((row): row is ScopeRow => !!row && typeof row === "object");
}

/** grant_status 1 is granted on GET /open-apis/application/v6/scopes. */
export function missingGrantedTenantScopes(payload: unknown, required: readonly string[] = FRESHNESS_REQUIRED_TENANT_SCOPES): string[] {
  const rows = asRows(payload);
  return required.filter((name) => !rows.some((row) => row.scope_name === name && row.grant_status === 1 && (row.scope_type === undefined || row.scope_type === "tenant")));
}

/** Reconcile intent with the authoritative bot scopes response, never credential return. */
export function reconcileTenantScopes(payload: unknown, requested: readonly string[]) {
  const root = payload && typeof payload === "object"
    ? payload as { code?: unknown; ok?: unknown; identity?: unknown; data?: { scopes?: unknown }; scopes?: unknown }
    : null;
  const verified = !!root && (root.code === undefined || root.code === 0) && (root.ok === undefined || root.ok === true)
    && (root.identity === undefined || root.identity === "bot")
    && (Array.isArray(root.data?.scopes) || Array.isArray(root.scopes));
  const required: readonly string[] = FRESHNESS_REQUIRED_TENANT_SCOPES;
  const optional = requested.filter((name) => !required.includes(name));
  return {
    verified,
    missingRequired: verified ? missingGrantedTenantScopes(payload, required) : [],
    missingOptional: verified ? missingGrantedTenantScopes(payload, optional) : [],
  };
}

/**
 * Capability each requested-but-optional tenant scope backs. The freshness gate
 * keeps `im:message.group_msg` as the only blocking requirement, but a missing
 * optional scope still degrades a named capability at runtime — an im:chat* gap
 * surfaces as "成员表拉取失败" in the daemon log, for example. Setup reports the
 * impact beside the scope names so the gap is visible before the first run.
 */
const OPTIONAL_SCOPE_CAPABILITIES: ReadonlyArray<{ capability: string; scopes: readonly string[] }> = [
  { capability: "群与成员信息（成员姓名/群名解析）", scopes: ["im:chat:readonly", "im:chat.group_info:readonly", "im:chat.members:read"] },
  { capability: "群管理（建群/改名/成员变更/退群）", scopes: ["im:chat", "im:chat:create", "im:chat:update", "im:chat.members:write_only", "im:chat:operate_as_owner"] },
  { capability: "云文档评论事件与回复", scopes: ["drive:drive", "docs:document.comment:read", "docs:document.comment:create"] },
  { capability: "应用可用范围自动设为全员可见", scopes: ["admin:app.visibility"] },
  { capability: "发送者签名中的工号（employee_id）", scopes: ["contact:user.employee_id:readonly"] },
  { capability: "机器人消息搜索", scopes: ["search:message"] },
  { capability: "消息收发与资源（基本消息能力）", scopes: ["im:message", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly", "im:message:send_as_bot", "im:resource"] },
];

/** Missing optional scopes grouped by the capability they degrade, in declaration order. */
export function missingOptionalScopeImpacts(missing: readonly string[]): string[] {
  const names = new Set(missing);
  const lines = OPTIONAL_SCOPE_CAPABILITIES.flatMap(({ capability, scopes }) => {
    const hit = scopes.filter((scope) => names.has(scope));
    return hit.length ? [`${capability}：${hit.join(", ")}`] : [];
  });
  const covered = new Set(OPTIONAL_SCOPE_CAPABILITIES.flatMap(({ scopes }) => scopes));
  const rest = missing.filter((scope) => !covered.has(scope));
  return rest.length ? [...lines, `其他权限：${rest.join(", ")}`] : lines;
}

/** Official console recovery form used by lark-cli; scopes are tenant permissions. */
export function tenantScopeRecoveryMessage(tenant: LarkinTenant, appId: string, scopes: readonly string[]): string {
  const url = new URL(`${openPlatformHost(tenant)}/app/${encodeURIComponent(appId)}/auth`);
  url.searchParams.set("q", scopes.join(","));
  url.searchParams.set("op_from", "openapi");
  url.searchParams.set("token_type", "tenant");
  return `保留同一个 App ID ${appId}，由应用 owner 打开开发者后台权限管理：${url.toString()}\n`
    + "完成平台要求的权限确认、管理员审批或版本发布，再重新核验实际授予状态。\n"
    + `完成后重跑原 larkin setup 命令，保留 --tenant ${tenant} 和 --runtime 参数（可加 --no-start），在网页选择同一个已有机器人并保留原 Runtime 配置，不要重建 Agent。\n`
    + "凭证回传不代表附加权限已授予；平台可能未应用 addons，不能仅靠重新扫码或重建应用修复。事件与 callbacks 仍需各自验证。";
}
