import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mod = await import(pathToFileURL(path.join(ROOT, "dist/setup/setup-authorization-url.mjs")).href);
const cli = await import(pathToFileURL(path.join(ROOT, "dist/setup/setup-official-cli-register.mjs")).href);

test("official CLI setup URL stays on the Lark open host and uses /page/cli", () => {
  const url = mod.officialCliSetupUrl({ tenant: "lark", userCode: "AB12-CD34", larkCliVersion: "1.0.87" });
  assert.equal(url, "https://open.larksuite.com/page/cli?user_code=AB12-CD34&lpv=1.0.87&ocv=1.0.87&from=cli");
  assert.doesNotMatch(url, /page\/launcher|feishu\.cn|addons=/);
});

test("presentAuthorizationUrl rewrites the broken Lark launcher to /page/cli", () => {
  const raw = "https://open.larksuite.com/page/launcher?user_code=YKDY-TZ7Q&from=sdk&source=node-sdk%2Flarkin&tp=sdk&addons=H4sI";
  const presented = mod.presentAuthorizationUrl(raw, { tenant: "lark", larkCliVersion: "1.0.87" });
  const parsed = new URL(presented);
  assert.equal(parsed.origin + parsed.pathname, "https://open.larksuite.com/page/cli");
  assert.equal(parsed.searchParams.get("user_code"), "YKDY-TZ7Q");
  assert.equal(parsed.searchParams.get("from"), "cli");
  assert.equal(parsed.searchParams.get("lpv"), "1.0.87");
  assert.equal(parsed.searchParams.get("ocv"), "1.0.87");
  assert.equal(parsed.searchParams.get("addons"), "H4sI");
  assert.doesNotMatch(presented, /page\/launcher/);
});

test("presentAuthorizationUrl rejects a launcher-only Lark URL", () => {
  assert.throws(
    () => mod.presentAuthorizationUrl("https://open.larksuite.com/page/launcher?from=sdk", {
      tenant: "lark",
      larkCliVersion: "1.0.87",
    }),
    /Lark 租户拒绝把 \/page\/launcher 交给浏览器/,
  );
});

test("presentAuthorizationUrl leaves Feishu launcher URLs unchanged", () => {
  const raw = "https://open.feishu.cn/page/launcher?user_code=AB12-CD34&from=sdk&source=node-sdk%2Flarkin&tp=sdk&addons=H4sI";
  const presented = mod.presentAuthorizationUrl(raw, { tenant: "feishu", larkCliVersion: "1.0.87" });
  assert.equal(presented, raw);
  assert.match(presented, /open\.feishu\.cn\/page\/launcher/);
  assert.doesNotMatch(presented, /page\/cli|larksuite\.com/);
});

test("authorization failure message names launcher ack 10074", () => {
  const message = mod.authorizationUrlFailureMessage({ code: "10074", message: "ack failed", description: "链接已失效" });
  assert.match(message, /10074/);
  assert.match(message, /page\/cli/);
  assert.match(message, /page\/launcher/);
});

test("official lark-cli init parser requires /page/cli and an App ID", () => {
  const parsed = cli.parseOfficialCliInitOutput([
    "打开以下链接配置应用:",
    "  https://open.larksuite.com/page/cli?user_code=E8G6-ZK7L&lpv=1.0.87&ocv=1.0.87&from=cli",
    'OK: 应用配置成功! App ID: cli_aa0e2efcc0b89e14',
    '{"appId":"cli_aa0e2efcc0b89e14","appSecret":"****","brand":"lark"}',
  ].join("\n"));
  assert.equal(parsed.appId, "cli_aa0e2efcc0b89e14");
  assert.equal(parsed.brand, "lark");
  assert.match(parsed.authorizationUrl, /\/page\/cli\?user_code=E8G6-ZK7L/);
  assert.deepEqual(cli.officialCliInitArgs("lark", "larkin-setup-1"), [
    "config", "init", "--new", "--brand", "lark", "--name", "larkin-setup-1",
  ]);
  assert.throws(() => cli.parseOfficialCliInitOutput("https://open.larksuite.com/page/launcher?user_code=AAAA-BBBB"), /\/page\/cli/);
  assert.throws(() => cli.parseOfficialCliInitOutput("App ID: cli_aa0e2efcc0b89e14\nhttps://open.larksuite.com/page/launcher?user_code=AAAA-BBBB"), /\/page\/cli/);
  assert.throws(() => cli.parseOfficialCliInitOutput([
    "https://open.larksuite.com/page/cli?user_code=E8G6-ZK7L&lpv=1.0.87&ocv=1.0.87&from=cli",
    "App ID: cli_aa0e2efcc0b89e14",
  ].join("\n")), /brand/);
});

test("bot-register wires Lark to /page/cli QR and keeps Feishu on launcher registerApp", () => {
  const shippedRegister = fs.readFileSync(path.join(ROOT, "dist/setup/bot-register.mjs"), "utf8");
  const larkStart = shippedRegister.indexOf('else if (selectedTenant === "lark")');
  const larkCall = shippedRegister.indexOf("result = await registerApp({", larkStart);
  const feishuCall = shippedRegister.indexOf("result = await registerApp({", larkCall + 1);
  assert.notEqual(larkStart, -1);
  assert.notEqual(larkCall, -1);
  assert.notEqual(feishuCall, -1);
  const larkBranch = shippedRegister.slice(larkStart, feishuCall);
  const feishuBranch = shippedRegister.slice(feishuCall, feishuCall + 1600);
  assert.match(larkBranch, /presentAuthorizationUrl/);
  assert.match(larkBranch, /registerAppAccountsHost\("feishu"\)/);
  assert.match(larkBranch, /page\/cli/);
  assert.match(larkBranch, /addons: LARKIN_REGISTER_ADDONS/);
  assert.doesNotMatch(larkBranch, /runOfficialCliAppInit|LARKIN_SETUP_APP_SECRET/);
  assert.doesNotMatch(larkBranch, /presentUrl\([^)]*launcher/);
  assert.match(feishuBranch, /registerApp\(/);
  assert.match(feishuBranch, /addons: LARKIN_REGISTER_ADDONS/);
  assert.match(feishuBranch, /presentUrl\(url, expireIn\)/);
  assert.doesNotMatch(feishuBranch, /presentAuthorizationUrl|page\/cli/);
});
