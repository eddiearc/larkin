import { openPlatformHost, type LarkinTenant } from "../feishu/platform-hosts.js";

/** Tenant scopes the freshness gate needs on the Bot application. */
export const FRESHNESS_REQUIRED_TENANT_SCOPES = ["im:message.group_msg"] as const;

interface ScopeRow {
  scope_name?: unknown;
  grant_status?: unknown;
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
  return required.filter((name) => !rows.some((row) => row.scope_name === name && row.grant_status === 1));
}

/** Reconcile intent with the authoritative bot scopes response, never credential return. */
export function reconcileTenantScopes(payload: unknown, requested: readonly string[]) {
  const root = payload && typeof payload === "object"
    ? payload as { code?: unknown; ok?: unknown; data?: { scopes?: unknown }; scopes?: unknown }
    : null;
  const verified = !!root && (root.code === undefined || root.code === 0) && root.ok !== false
    && (Array.isArray(root.data?.scopes) || Array.isArray(root.scopes));
  const required: readonly string[] = FRESHNESS_REQUIRED_TENANT_SCOPES;
  const optional = requested.filter((name) => !required.includes(name));
  return {
    verified,
    missingRequired: missingGrantedTenantScopes(verified ? payload : null, required),
    missingOptional: missingGrantedTenantScopes(verified ? payload : null, optional),
  };
}

/** Official console recovery form used by lark-cli; scopes are tenant permissions. */
export function tenantScopeRecoveryMessage(tenant: LarkinTenant, appId: string, scopes: readonly string[]): string {
  const url = new URL(`${openPlatformHost(tenant)}/app/${encodeURIComponent(appId)}/auth`);
  url.searchParams.set("q", scopes.join(","));
  url.searchParams.set("op_from", "openapi");
  url.searchParams.set("token_type", "tenant");
  return `保留同一个 App ID ${appId}，由应用 owner 打开开发者后台权限管理：${url.toString()}\n`
    + "完成平台要求的权限确认、管理员审批或版本发布，再重新核验实际授予状态。\n"
    + `运行 larkin setup --tenant ${tenant} --no-start，在网页选择同一个已有机器人并保留原 Runtime 配置，不要重建 Agent；核验通过后再启动。\n`
    + "凭证回传不代表附加权限已授予；平台可能未应用 addons，不能仅靠重新扫码或重建应用修复。事件与 callbacks 仍需各自验证。";
}
