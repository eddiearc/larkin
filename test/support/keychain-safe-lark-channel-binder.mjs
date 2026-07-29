import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (JSON.stringify(argv) !== JSON.stringify(["config", "bind", "--source", "lark-channel", "--identity", "bot-only"])) {
  process.stderr.write(`unexpected binder argv: ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const sourceFile = process.env.LARK_CHANNEL_CONFIG;
const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR;
if (!sourceFile || !configDir) {
  process.stderr.write("LARK_CHANNEL_CONFIG and LARKSUITE_CLI_CONFIG_DIR are required\n");
  process.exit(2);
}

const source = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
const appId = source.accounts?.app?.id;
if (typeof appId !== "string" || !appId) {
  process.stderr.write("source projection has no App identity\n");
  process.exit(2);
}

const workspaceDir = path.join(configDir, "lark-channel");
fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
fs.chmodSync(workspaceDir, 0o700);
fs.writeFileSync(path.join(workspaceDir, "config.json"), `${JSON.stringify({
  apps: [{
    appId,
    appSecret: { source: "keychain", id: `appsecret:${appId}` },
    defaultAs: "bot",
    strictMode: "bot",
    users: {},
  }],
}, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify({ ok: true, source: "lark-channel", identity: "bot-only" })}\n`);
