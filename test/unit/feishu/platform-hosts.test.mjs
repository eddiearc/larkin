import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hosts = await import(pathToFileURL(path.join(ROOT, "dist/feishu/platform-hosts.mjs")).href);

test("open and accounts hosts match official Feishu vs Lark ResolveEndpoints", () => {
  assert.equal(hosts.openPlatformHost("lark"), "https://open.larksuite.com");
  assert.equal(hosts.openPlatformHost("feishu"), "https://open.feishu.cn");
  assert.equal(hosts.registerAppAccountsHost("lark"), "accounts.larksuite.com");
  assert.equal(hosts.registerAppAccountsHost("feishu"), "accounts.feishu.cn");
});

test("Lark helper outputs never contain feishu.cn and Feishu outputs never contain larksuite.com", () => {
  const larkValues = [
    hosts.openPlatformHost("lark"),
    hosts.registerAppAccountsHost("lark"),
    hosts.PLATFORM_HOSTS.lark.accounts,
    hosts.PLATFORM_HOSTS.lark.applink,
    hosts.PLATFORM_HOSTS.lark.docs,
    hosts.PLATFORM_HOSTS.lark.console,
  ];
  const feishuValues = [
    hosts.openPlatformHost("feishu"),
    hosts.registerAppAccountsHost("feishu"),
    hosts.PLATFORM_HOSTS.feishu.accounts,
    hosts.PLATFORM_HOSTS.feishu.applink,
    hosts.PLATFORM_HOSTS.feishu.docs,
    hosts.PLATFORM_HOSTS.feishu.console,
  ];
  for (const value of larkValues) assert.doesNotMatch(value, /feishu\.cn/);
  for (const value of feishuValues) assert.doesNotMatch(value, /larksuite\.com/);
});

test("requireOpenDomain accepts only official Open hosts and fail-closes otherwise", () => {
  assert.equal(hosts.requireOpenDomain("https://open.larksuite.com"), "https://open.larksuite.com");
  assert.equal(hosts.requireOpenDomain("https://open.feishu.cn"), "https://open.feishu.cn");
  assert.throws(() => hosts.requireOpenDomain(undefined), /missing or invalid Open Platform domain/);
  assert.throws(() => hosts.requireOpenDomain("https://open.larkoffice.com"), /missing or invalid Open Platform domain/);
  assert.throws(() => hosts.requireOpenDomain("lark"), /missing or invalid Open Platform domain/);
});
