import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const enabled = process.env.LARKIN_RUN_STANDALONE_SETUP_WORKFLOW === "1";

function checked(result, label) {
  assert.equal(result.error, undefined, `${label}: ${result.error?.message || "spawn error"}`);
  assert.equal(result.status, 0, `${label} failed\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`);
  return result;
}

function writeLarkCli(binDir) {
  const packageDir = path.join(path.dirname(binDir), "official", "node_modules", "@larksuite", "cli");
  const launcher = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then printf '%s\n' 'Usage: config bind --source lark-channel --identity bot-only'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ]; then
  ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs"),path=require("node:path"),source=JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG,"utf8")),id=source.accounts.app.id,dir=path.join(process.env.LARKSUITE_CLI_CONFIG_DIR,"lark-channel");fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,"config.json"),JSON.stringify({apps:[{appId:id,appSecret:{source:"keychain",id:"appsecret:"+id},defaultAs:"bot",strictMode:"bot",users:[]}]}),{mode:0o600})'
  exit $?
fi
count=0
if [ -f "$SETUP_LARK_CALLS" ]; then count=$(grep -c '+chat-list' "$SETUP_LARK_CALLS"); fi
printf '%s\n' "$*" >> "$SETUP_LARK_CALLS"
if [ "$1" = "profile" ] && [ "$2" = "list" ]; then
  printf '[{"name":"%s","appId":"%s","active":true}]\n' "$SETUP_APP_ID" "$SETUP_APP_ID"
elif printf '%s\n' "$*" | grep -q '+chat-list'; then
    if [ "$SETUP_OVERFLOW_BIND_VERIFY" = "1" ]; then
      head -c 131072 /dev/zero | tr '\\0' x
      exit 0
    fi
    if [ "$SETUP_HANG_BIND_VERIFY" = "1" ]; then
      if [ "$SETUP_IGNORE_TERM_BIND_VERIFY" = "1" ]; then
        exec ${JSON.stringify(process.execPath)} --eval 'const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.env.SETUP_TERM_MARKER,"term"));fs.writeFileSync(process.env.SETUP_IDENTITY_MARKER,"ready");setTimeout(()=>fs.writeFileSync(process.env.SETUP_LATE_WORKSPACE_MARKER,"late-workspace-write"),3000);setInterval(()=>{},1000)'
      fi
      : > "$SETUP_IDENTITY_MARKER"
      while :; do sleep 1; done
    fi
    if [ "$SETUP_FAIL_BIND_VERIFY" = "1" ] || { [ "$SETUP_FAIL_BIND_VERIFY" = "second" ] && [ "$count" -ge 1 ]; }; then
      printf '%s\n' '{"ok":false,"identity":"bot"}'
      exit 1
    fi
    printf '%s\n' '{"ok":true,"identity":"bot","data":{"chats":[]}}'
elif printf '%s\n' "$*" | grep -q 'application/v6/scopes'; then
  printf '%s\n' '{"data":{"scopes":[{"scope_name":"im:message.group_msg","grant_status":1}]}}'
else
  printf '%s\n' '{"ok":true}'
fi
`, { mode: 0o755 });
  fs.symlinkSync(launcher, path.join(binDir, "lark-cli"));
}

function writeRegisterFixture(temp) {
  const fixture = path.join(temp, "register-fixture.mjs");
  fs.writeFileSync(fixture, `import { spawnSync as systemSpawnSync } from "node:child_process";
export async function registerApp() {
  return { client_id: process.env.SETUP_APP_ID, client_secret: "standalone-fixture-secret", user_info: { tenant_brand: "feishu", open_id: "ou_fixture" } };
}
export const qrcode = { generate() {} };
export function spawnSync(command, args, options) {
  if (command === "open" || command === "xdg-open" || command === "cmd") return { status: 0, stdout: "", stderr: "" };
  return systemSpawnSync(command, args, options);
}
`, { mode: 0o600 });
  return fixture;
}

function writeCodexFixture(temp, binDir) {
  const source = path.join(temp, "codex-fixture.mjs");
  const executable = path.join(binDir, "codex");
  fs.writeFileSync(source, `import readline from "node:readline";
if (process.argv.includes("--version")) { console.log("codex-fixture 1.0.0"); process.exit(0); }
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  if (request.method === "initialize") return output({ jsonrpc: "2.0", id: request.id, result: { userAgent: "setup-fixture" } });
  if (request.method === "model/list") return output({ jsonrpc: "2.0", id: request.id, result: { data: [{ id: "codex-fixture", model: "codex-fixture", displayName: "Fixture", hidden: false, isDefault: true, supportedReasoningEfforts: [] }] } });
  if (request.id != null) output({ jsonrpc: "2.0", id: request.id, result: {} });
});
`, { mode: 0o600 });
  checked(spawnSync(process.execPath, ["build", source, "--compile", "--minify", `--outfile=${executable}`], {
    cwd: temp, encoding: "utf8", timeout: 60_000,
  }), "compile Codex setup fixture");
  return executable;
}

test.skipIf(!enabled)("compiled setup-bind and public setup preserve Agent config and propagate lark-channel verification failures", { timeout: 180_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-standalone-setup-"));
  const releaseDir = path.join(temp, "release");
  const configDir = path.join(temp, "config");
  const binDir = path.join(temp, "bin");
  const firstAgent = "cli_setupExistingA1";
  const secondAgent = "cli_setupAddedB2";
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    let artifact = process.env.LARKIN_STANDALONE_ARTIFACT;
    if (!artifact) {
      checked(spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000 }), "build production dist");
      checked(spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`, "--out-dir", releaseDir, "--allow-dirty"], {
        cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000,
      }), "compile standalone artifact");
      const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
      artifact = path.join(releaseDir, manifest.artifacts[0].file);
    }
    assert.equal(fs.statSync(artifact).isFile(), true);
    const configFile = path.join(configDir, "config.json");
    const initial = {
      version: 4, serverId: "server-standalone-setup", mentionPolicy: "require", activeAgent: firstAgent,
      agents: { [firstAgent]: { runtime: "codex", model: "default", createdAt: "2026-07-01T00:00:00.000Z" } },
    };
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    writeLarkCli(binDir);
    const fixtureHome = path.join(temp, "home");
    fs.mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fixtureHome, ".bash_profile"), `export PATH=${JSON.stringify(binDir)}:/usr/bin:/bin\n`, { mode: 0o600 });
    const baseEnv = {
      HOME: fixtureHome, SHELL: "/bin/bash", LARKIN_CONFIG_DIR: configDir,
      PATH: `${binDir}${path.delimiter}/usr/bin:/bin`, SETUP_APP_ID: secondAgent,
      SETUP_LARK_CALLS: path.join(temp, "lark-calls"),
    };

    const added = spawnSync(artifact, ["__internal", "setup-bind", "--profile", secondAgent, "--agent", secondAgent, "--runtime", "codex", "--yes"], {
      cwd: temp, env: baseEnv, encoding: "utf8", timeout: 30_000,
    });
    checked(added, `compiled setup-bind (lark calls: ${fs.existsSync(baseEnv.SETUP_LARK_CALLS) ? fs.readFileSync(baseEnv.SETUP_LARK_CALLS, "utf8").trim() : "none"})`);
    const configured = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(configured.agents), [firstAgent, secondAgent]);
    assert.equal(configured.agents[secondAgent].runtime, "codex");
    assert.equal(configured.activeAgent, firstAgent, "adding an Agent must preserve the existing active selection");
    assert.match(added.stderr + added.stdout, /已写配置/);

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const publicEnv = {
      ...baseEnv,
      LARKIN_TEST_BOT_REGISTER_MODULE: writeRegisterFixture(temp),
      LARKIN_CODEX_COMMAND: writeCodexFixture(temp, binDir),
    };
    fs.mkdirSync(path.join(configDir, "agents", secondAgent), { recursive: true, mode: 0o700 });
    const publicSetup = spawnSync(artifact, ["setup", "--runtime", "codex", "--no-start"], {
      cwd: temp, env: publicEnv, encoding: "utf8", timeout: 30_000,
    });
    checked(publicSetup, "compiled public setup");
    const publicConfigured = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(publicConfigured.agents), [firstAgent, secondAgent]);
    assert.match(publicSetup.stderr + publicSetup.stdout, new RegExp(`Agent ${secondAgent} 已配置`));

    const artifactBytes = fs.readFileSync(artifact);
    assert.equal(artifactBytes.includes(Buffer.from("official-pi")), false, "standalone binary must not contain official-pi");
    assert.equal(artifactBytes.includes(Buffer.from(".larkin-official-pi-package")), false,
      "standalone binary must not contain .larkin-official-pi-package");

    const legacyAgent = "cli_legacyBuiltinA1";
    const siblingAgent = "cli_legacyCodexB2";
    const legacyDir = path.join(configDir, "providers", "pi", legacyAgent);
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyDir, "auth.json"), `${JSON.stringify({ leftover: { type: "api_key", key: "must-be-deleted" } })}\n`, { mode: 0o600 });
    fs.writeFileSync(configFile, `${JSON.stringify({
      version: 4, serverId: "server-standalone-setup", mentionPolicy: "require", activeAgent: legacyAgent,
      agents: {
        [legacyAgent]: { runtime: "pi", model: "fixture/kept-model", piDistribution: "builtin" },
        [siblingAgent]: { runtime: "codex", model: "default", createdAt: "2026-07-01T00:00:00.000Z" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    const migrated = spawnSync(artifact, ["agents", "--json"], {
      cwd: temp, env: { ...baseEnv, PATH: `${binDir}${path.delimiter}/usr/bin:/bin` }, encoding: "utf8", timeout: 30_000,
    });
    checked(migrated, "legacy builtin-pi Agent migrates on compiled agents --json");
    const migratedConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(migratedConfig.agents[legacyAgent].runtime, "pi");
    assert.equal(migratedConfig.agents[legacyAgent].model, "fixture/kept-model");
    assert.equal(Object.hasOwn(migratedConfig.agents[legacyAgent], "piDistribution"), false);
    assert.deepEqual(migratedConfig.agents[siblingAgent], {
      runtime: "codex", model: "default", createdAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(fs.existsSync(legacyDir), false, "migrated Agent must lose providers/pi/<id>/");

    const missingClaude = spawnSync(artifact, ["runtime", "claude", "--agent", siblingAgent], {
      cwd: temp,
      env: {
        ...baseEnv,
        PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
        LARKIN_CLAUDE_COMMAND: path.join(temp, "definitely-not-installed-claude"),
      },
      encoding: "utf8", timeout: 15_000,
    });
    assert.notEqual(missingClaude.status, 0, missingClaude.stdout + missingClaude.stderr);
    assert.match(`${missingClaude.stdout}\n${missingClaude.stderr}`, /claude is not installed|Install Claude Code|LARKIN_CLAUDE_COMMAND/);
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).agents[siblingAgent].runtime, "codex");

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!${process.execPath}
if (process.argv.includes("--version")) { process.stdout.write("0.84.2\\n"); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const piSetup = spawnSync(artifact, ["setup", "--runtime", "pi", "--no-start"], {
      cwd: temp,
      env: {
        ...baseEnv,
        PATH: `${binDir}${path.delimiter}/usr/bin:/bin`,
        LARKIN_PI_COMMAND: fakePi,
        LARKIN_TEST_BOT_REGISTER_MODULE: writeRegisterFixture(temp),
      },
      encoding: "utf8", timeout: 30_000,
    });
    assert.doesNotMatch(`${piSetup.stdout}\n${piSetup.stderr}`, /pi is not installed/);
    assert.match(`${piSetup.stdout}\n${piSetup.stderr}`, /官方 lark-cli|setup 0\/5|机器人|Agent/,
      `setup --runtime pi with fake pi on PATH must proceed past the install check\n${piSetup.stdout}\n${piSetup.stderr}`);

    for (const command of ["pi-auth", "pi-distribution"]) {
      const unknown = spawnSync(artifact, [command], {
        cwd: temp, env: baseEnv, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(unknown.status, 1, `${command} must be unknown\n${unknown.stdout}\n${unknown.stderr}`);
      assert.match(unknown.stdout, /larkin <command>/);
      assert.doesNotMatch(`${unknown.stdout}\n${unknown.stderr}`, /Usage: larkin pi-auth|Usage: larkin pi-distribution/);
    }

    fs.writeFileSync(configFile, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(baseEnv.SETUP_LARK_CALLS, { force: true });
    const publicFailed = spawnSync(artifact, ["setup", "--runtime", "codex", "--no-start"], {
      cwd: temp, env: { ...publicEnv, SETUP_FAIL_BIND_VERIFY: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.notEqual(publicFailed.status, 0, publicFailed.stderr + publicFailed.stdout);
    assert.doesNotMatch(publicFailed.stderr + publicFailed.stdout, new RegExp(`Agent ${secondAgent} 已配置`));
    const recoverable = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(recoverable.agents), [firstAgent, secondAgent]);
    assert.equal(recoverable.activeAgent, firstAgent);
    assert.equal(fs.existsSync(path.join(configDir, "bots", `${secondAgent}.json`)), true,
      "verification failure must preserve the authoritative credential for recovery");
    assert.equal(fs.existsSync(path.join(configDir, "state", "agents", secondAgent, "lark-cli-config", "lark-channel", "config.json")), true,
      "verification failure must preserve the successful official workspace binding");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
