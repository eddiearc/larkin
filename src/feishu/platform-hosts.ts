// Official Feishu vs Lark hosts from @larksuite/cli ResolveEndpoints
// (open / accounts / applink) plus Open-host docs and console paths.
// Do not add larkoffice.com or any unofficial host.

export type LarkinTenant = "feishu" | "lark";

export const PLATFORM_HOSTS = {
  feishu: {
    open: "https://open.feishu.cn",
    accounts: "https://accounts.feishu.cn",
    applink: "https://applink.feishu.cn",
    docs: "https://open.feishu.cn/document",
    console: "https://open.feishu.cn/app",
  },
  lark: {
    open: "https://open.larksuite.com",
    accounts: "https://accounts.larksuite.com",
    applink: "https://applink.larksuite.com",
    docs: "https://open.larksuite.com/document",
    console: "https://open.larksuite.com/app",
  },
} as const;

export type OpenPlatformHost = typeof PLATFORM_HOSTS[LarkinTenant]["open"];

export function parseLarkinTenant(value: unknown): LarkinTenant | null {
  return value === "feishu" || value === "lark" ? value : null;
}

export function openPlatformHost(tenant: LarkinTenant): OpenPlatformHost {
  return PLATFORM_HOSTS[tenant].open;
}

export function registerAppAccountsHost(tenant: LarkinTenant): string {
  // node-sdk registerApp.domain / larkDomain interpolate https://${host}
  return new URL(PLATFORM_HOSTS[tenant].accounts).host;
}

export function isOpenPlatformHost(value: unknown): value is OpenPlatformHost {
  return value === PLATFORM_HOSTS.feishu.open || value === PLATFORM_HOSTS.lark.open;
}

export function requireOpenDomain(value: unknown): OpenPlatformHost {
  if (isOpenPlatformHost(value)) return value;
  throw new Error("missing or invalid Open Platform domain");
}

export function accountTenantFromOpenHost(domain: OpenPlatformHost): LarkinTenant {
  return domain === PLATFORM_HOSTS.lark.open ? "lark" : "feishu";
}
