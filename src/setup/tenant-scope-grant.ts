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
