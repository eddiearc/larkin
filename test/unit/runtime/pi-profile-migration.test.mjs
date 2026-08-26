import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const migration = await import(pathToFileURL(path.join(ROOT, "dist/runtime/pi-profile-migration.mjs")).href);
const provenance = await import(pathToFileURL(path.join(ROOT, "dist/runtime/pi-artifact-provenance.mjs")).href);

function fixture({ target = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-profile-migration-"));
  const source = path.join(root, "external", "agent");
  const bin = path.join(root, "bin");
  const config = path.join(root, "config");
  const agent = "cli_profileMigrationA1";
  fs.mkdirSync(source, { recursive: true, mode: 0o755 });
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  const version = path.join(bin, "pi");
  const probeLog = path.join(bin, "probe.ndjson");
  fs.writeFileSync(probeLog, "");
  fs.writeFileSync(version, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
try {
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), "probe.ndjson"), JSON.stringify({
    packageDir: process.env.PI_PACKAGE_DIR || null,
    cwd: process.cwd(),
    path: process.env.PATH || null,
    command: process.env.LARKIN_PI_COMMAND || null,
    codingAgentDir: process.env.PI_CODING_AGENT_DIR || null,
    offline: process.env.PI_OFFLINE || null,
    skipVersion: process.env.PI_SKIP_VERSION_CHECK || null,
    distribution: process.env.LARKIN_PI_DISTRIBUTION || null,
    configDir: process.env.LARKIN_CONFIG_DIR || null,
  }) + "\\n");
} catch {}
console.log("0.84.2");
`, { mode: 0o700 });
  fs.chmodSync(version, 0o700);
  const auth = Buffer.from('{"fixture":{"type":"api_key","key":"PRIVATE_FIXTURE_SECRET"}}\n');
  const models = Buffer.from('{"providers":{"fixture":{"models":[{"id":"fixture-model","contextWindow":272000}]}}}\n');
  const settings = Buffer.from('{"theme":"dark","compaction":{"enabled":false,"reserveTokens":1,"keepRecentTokens":2},"packages":{"enabled":true}}\n');
  fs.writeFileSync(path.join(source, "auth.json"), auth, { mode: 0o600 });
  fs.writeFileSync(path.join(source, "models.json"), models, { mode: 0o644 });
  fs.writeFileSync(path.join(source, "settings.json"), settings, { mode: 0o644 });
  const targetDir = path.join(config, "providers", "pi", agent);
  if (target) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(targetDir, "auth.json"), "prior-auth", { mode: 0o600 });
    fs.writeFileSync(path.join(targetDir, "models.json"), "prior-models", { mode: 0o600 });
    fs.writeFileSync(path.join(targetDir, "settings.json"), JSON.stringify({ keep: true, compaction: { enabled: false } }), { mode: 0o600 });
    fs.writeFileSync(path.join(targetDir, "unrelated.txt"), "must-survive", { mode: 0o600 });
  }
  const env = { HOME: root, PATH: `${bin}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: source };
  return { root, source, config, targetDir, agent, env, auth, models, probeLog };
}

function clean(f) { fs.rmSync(f.root, { recursive: true, force: true }); }

test("profile apply does not inherit a later ambient package root when the plan had none", () => {
  const f = fixture();
  const minimal = path.join(f.root, ".larkin-official-pi-package");
  fs.mkdirSync(path.join(minimal, "theme"), { recursive: true });
  fs.writeFileSync(path.join(minimal, "theme", "dark.json"), "{}\n");
  const later = path.join(f.root, "later-root");
  fs.mkdirSync(path.join(later, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(later, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  const previous = {
    PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_OFFLINE: process.env.PI_OFFLINE,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
    LARKIN_PI_DISTRIBUTION: process.env.LARKIN_PI_DISTRIBUTION,
    LARKIN_CONFIG_DIR: process.env.LARKIN_CONFIG_DIR,
  };
  try {
    fs.writeFileSync(f.probeLog, "");
    const plan = migration.preparePiProfileMigration({ ...f.env, PI_PACKAGE_DIR: minimal }, f.config, f.agent, "external");
    assert.equal(plan.sourceEnvironment.PI_PACKAGE_DIR, undefined);
    const prepareProbes = fs.readFileSync(f.probeLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.ok(prepareProbes.length >= 1);
    assert.equal(prepareProbes.every((row) => row.packageDir == null), true, JSON.stringify(prepareProbes));
    process.env.PI_CODING_AGENT_DIR = "/tmp/polluted-agent";
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env.LARKIN_PI_DISTRIBUTION = "builtin";
    process.env.LARKIN_CONFIG_DIR = "/tmp/polluted-config";
    fs.writeFileSync(f.probeLog, "");
    migration.applyPiProfileMigration(plan);
    const applyProbes = fs.readFileSync(f.probeLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(applyProbes.length, 1, JSON.stringify(applyProbes));
    assert.equal(applyProbes[0].packageDir, null);
    assert.equal(applyProbes[0].codingAgentDir, null);
    assert.equal(applyProbes[0].offline, null);
    assert.equal(applyProbes[0].skipVersion, null);
    assert.equal(applyProbes[0].distribution, null);
    assert.equal(applyProbes[0].configDir, null);
    assert.equal(applyProbes[0].command, "pi");
    assert.equal(fs.realpathSync(applyProbes[0].cwd), fs.realpathSync(plan.state.sourceDir));
    assert.equal(applyProbes[0].path, plan.sourceEnvironment.PATH);
    assert.equal(fs.existsSync(path.join(f.targetDir, "auth.json")), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clean(f);
  }
});

test("prepare/apply/rollback probes ignore a later ambient package root", () => {
  const f = fixture();
  const planned = path.join(f.root, "planned-root");
  const later = path.join(f.root, "later-valid");
  for (const root of [planned, later]) {
    fs.mkdirSync(path.join(root, "dist", "modes", "interactive", "theme"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "modes", "interactive", "theme", "dark.json"), `${JSON.stringify({ root: path.basename(root) })}\n`);
  }
  const previous = process.env.PI_PACKAGE_DIR;
  const lock = path.join(f.config, "providers", "pi", `${f.agent}.larkin-pi-import.lock`);
  const readProbes = () => fs.readFileSync(f.probeLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  try {
    fs.writeFileSync(f.probeLog, "");
    const plan = migration.preparePiProfileMigration({ ...f.env, PI_PACKAGE_DIR: planned }, f.config, f.agent, "external");
    const prepareProbes = readProbes();
    assert.equal(prepareProbes.length, 1, JSON.stringify(prepareProbes));
    assert.equal(fs.realpathSync(prepareProbes[0].packageDir), fs.realpathSync(planned));
    process.env.PI_PACKAGE_DIR = later;
    fs.writeFileSync(f.probeLog, "");
    migration.applyPiProfileMigration(plan);
    const applyProbes = readProbes();
    assert.equal(applyProbes.length, 1, JSON.stringify(applyProbes));
    assert.equal(fs.realpathSync(applyProbes[0].packageDir), fs.realpathSync(planned));
    assert.equal(applyProbes[0].packageDir.includes("later-valid"), false);
    fs.writeFileSync(f.probeLog, "");
    migration.rollbackPiProfileMigration(plan.state);
    const rollbackProbes = readProbes();
    assert.equal(rollbackProbes.every((row) => !String(row.packageDir || "").includes("later-valid")), true, JSON.stringify(rollbackProbes));
    assert.equal(fs.existsSync(path.join(f.targetDir, "auth.json")), false);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previous;
    clean(f);
  }
});

test("profile apply rejects symlink retarget and theme content mutation", () => {
  const f = fixture();
  const pkg = path.join(f.root, "planned-root");
  const alt = path.join(f.root, "alternate-root");
  fs.mkdirSync(path.join(pkg, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  fs.mkdirSync(path.join(alt, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(alt, "dist", "modes", "interactive", "theme", "dark.json"), "{\"alt\":true}\n");
  try {
    const plan = migration.preparePiProfileMigration({ ...f.env, PI_PACKAGE_DIR: pkg }, f.config, f.agent, "external");
    fs.rmSync(pkg, { recursive: true, force: true });
    fs.symlinkSync(alt, pkg);
    assert.throws(() => migration.applyPiProfileMigration(plan), /package root changed/);
    assert.equal(fs.existsSync(path.join(f.targetDir, "auth.json")), false);
  } finally { clean(f); }
  const g = fixture();
  const live = path.join(g.root, "live-root");
  fs.mkdirSync(path.join(live, "dist", "modes", "interactive", "theme"), { recursive: true });
  const theme = path.join(live, "dist", "modes", "interactive", "theme", "dark.json");
  fs.writeFileSync(theme, "{}\n");
  try {
    const plan = migration.preparePiProfileMigration({ ...g.env, PI_PACKAGE_DIR: live }, g.config, g.agent, "external");
    fs.writeFileSync(theme, "{\"mutated\":true}\n");
    assert.throws(() => migration.applyPiProfileMigration(plan), /package root changed/);
    assert.equal(fs.existsSync(path.join(g.targetDir, "auth.json")), false);
  } finally { clean(g); }
});

test("profile apply fails closed when the planned package root becomes stale", () => {
  const f = fixture();
  const pkg = path.join(f.root, "planned-root");
  fs.mkdirSync(path.join(pkg, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  try {
    const plan = migration.preparePiProfileMigration({ ...f.env, PI_PACKAGE_DIR: pkg }, f.config, f.agent, "external");
    assert.equal(plan.sourceEnvironment.PI_PACKAGE_DIR, fs.realpathSync(pkg));
    fs.rmSync(pkg, { recursive: true, force: true });
    assert.throws(() => migration.applyPiProfileMigration(plan), /package root changed/);
    assert.equal(fs.existsSync(path.join(f.targetDir, "auth.json")), false);
  } finally { clean(f); }
});

test("profile migration plan persists a canonical external package root", () => {
  const f = fixture();
  const pkg = path.join(f.root, "nix", "store", "hash-pi");
  fs.mkdirSync(path.join(pkg, "dist", "modes", "interactive", "theme"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "dist", "modes", "interactive", "theme", "dark.json"), "{}\n");
  try {
    const plan = migration.preparePiProfileMigration({ ...f.env, PI_PACKAGE_DIR: pkg }, f.config, f.agent, "external");
    assert.equal(plan.sourceEnvironment.PI_PACKAGE_DIR, fs.realpathSync(pkg));
  } finally { clean(f); }
});

 test("imports only auth/models/settings, preserves provider bytes, owns modes, and rolls back an absent target", () => {
  const f = fixture();
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    assert.equal(fs.statSync(f.targetDir).mode & 0o777, 0o700);
    for (const name of ["auth.json", "models.json", "settings.json"]) assert.equal(fs.statSync(path.join(f.targetDir, name)).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(f.targetDir, "auth.json")), f.auth);
    assert.deepEqual(fs.readFileSync(path.join(f.targetDir, "models.json")), f.models);
    const settings = JSON.parse(fs.readFileSync(path.join(f.targetDir, "settings.json")));
    assert.deepEqual(settings.compaction, { enabled: true, reserveTokens: 40800, keepRecentTokens: 20000 });
    assert.equal(settings.theme, "dark");
    migration.rollbackPiProfileMigration(plan.state);
    assert.equal(fs.existsSync(f.targetDir), false);
  } finally { clean(f); }
});

test("builtin import removes only bundled subagents while external import preserves it", () => {
  const f = fixture();
  try {
    const sourceSettings = {
      theme: "dark",
      packages: ["npm:pi-codex-goal", "npm:@tintinweb/pi-subagents", "npm:@tintinweb/pi-subagents@latest"],
    };
    fs.writeFileSync(path.join(f.source, "settings.json"), `${JSON.stringify(sourceSettings)}\n`, { mode: 0o644 });

    const builtin = migration.preparePiProfileMigration(f.env, f.config, f.agent, "builtin");
    migration.applyPiProfileMigration(builtin);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.targetDir, "settings.json"))).packages, ["npm:pi-codex-goal"]);
    migration.rollbackPiProfileMigration(builtin.state);

    const external = migration.preparePiProfileMigration(f.env, f.config, f.agent, "external");
    migration.applyPiProfileMigration(external);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.targetDir, "settings.json"))).packages, sourceSettings.packages);
    migration.rollbackPiProfileMigration(external.state);
  } finally { clean(f); }
});

test("preserves prior target and unrelated files on reverse rollback", () => {
  const f = fixture({ target: true });
  try {
    const prior = Object.fromEntries(["auth.json", "models.json", "settings.json"].map((name) => [name, fs.readFileSync(path.join(f.targetDir, name))]));
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    migration.rollbackPiProfileMigration(plan.state);
    for (const name of Object.keys(prior)) assert.deepEqual(fs.readFileSync(path.join(f.targetDir, name)), prior[name]);
    assert.equal(fs.readFileSync(path.join(f.targetDir, "unrelated.txt"), "utf8"), "must-survive");
  } finally { clean(f); }
});

test("rejects source symlinks, hardlinks, and source tampering without writing a target", () => {
  const f = fixture();
  try {
    fs.renameSync(path.join(f.source, "models.json"), path.join(f.source, "models.real.json"));
    fs.symlinkSync(path.join(f.source, "models.real.json"), path.join(f.source, "models.json"));
    assert.throws(() => migration.preparePiProfileMigration(f.env, f.config, f.agent), /unsafe/);
    fs.unlinkSync(path.join(f.source, "models.json")); fs.renameSync(path.join(f.source, "models.real.json"), path.join(f.source, "models.json"));
    const hardlink = path.join(f.root, "models-hardlink");
    fs.linkSync(path.join(f.source, "models.json"), hardlink); fs.unlinkSync(path.join(f.source, "models.json")); fs.linkSync(hardlink, path.join(f.source, "models.json"));
    assert.throws(() => migration.preparePiProfileMigration(f.env, f.config, f.agent), /unsafe/);
    fs.unlinkSync(path.join(f.source, "models.json")); fs.renameSync(hardlink, path.join(f.source, "models.json"));
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    fs.appendFileSync(path.join(f.source, "settings.json"), "tampered");
    assert.throws(() => migration.applyPiProfileMigration(plan), /changed/);
    assert.equal(fs.existsSync(f.targetDir), false);
  } finally { clean(f); }
});

test("rechecks the executable and target preexistence before writing", () => {
  const f = fixture();
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    fs.appendFileSync(path.join(f.root, "bin", "pi"), "\n");
    assert.throws(() => migration.applyPiProfileMigration(plan), /executable.*changed/);
    assert.equal(fs.existsSync(f.targetDir), false);

    const second = fixture();
    try {
      const secondPlan = migration.preparePiProfileMigration(second.env, second.config, second.agent);
      fs.mkdirSync(path.dirname(second.targetDir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(second.targetDir, { recursive: true, mode: 0o700 });
      assert.throws(() => migration.applyPiProfileMigration(secondPlan), /target changed/);
      assert.equal(fs.readdirSync(second.targetDir).length, 0);
    } finally { clean(second); }
  } finally { clean(f); }
});

test("rejects a symlink target and refuses rollback after source tampering", () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-profile-outside-"));
  try {
    fs.mkdirSync(path.dirname(f.targetDir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, f.targetDir);
    assert.throws(() => migration.preparePiProfileMigration(f.env, f.config, f.agent), /symlink|unsafe/);
    fs.unlinkSync(f.targetDir);
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    fs.appendFileSync(path.join(f.source, "auth.json"), "changed");
    assert.throws(() => migration.rollbackPiProfileMigration(plan.state), /changed/);
  } finally { clean(f); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("rejects tampered rollback bytes before touching the target", () => {
  const f = fixture({ target: true });
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    plan.state.priorFiles["auth.json"].content = Buffer.from("tampered").toString("base64");
    assert.throws(() => migration.rollbackPiProfileMigration(plan.state), /invalid/);
    assert.equal(fs.readFileSync(path.join(f.targetDir, "auth.json"), "utf8"), "prior-auth");
  } finally { clean(f); }
});

test("reverse rollback removes only startup-created official Pi artifacts from an absent target", () => {
  const f = fixture();
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    const boundary = Date.now();
    fs.mkdirSync(path.join(f.targetDir, ".larkin-official-pi-package", "theme"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(f.targetDir, ".larkin-official-pi-package", "package.json"), "{}\n", { mode: 0o600 });
    fs.writeFileSync(path.join(f.targetDir, "models-store.json"), "{}\n", { mode: 0o600 });
    fs.mkdirSync(path.join(f.targetDir, "npm"), { mode: 0o700 });
    provenance.recordPiRuntimeArtifactProvenance(f.targetDir, new Set(), boundary);
    migration.rollbackPiProfileMigration(plan.state);
    assert.equal(fs.existsSync(f.targetDir), false);
  } finally { clean(f); }
});

test("preserves user-created allowed-name artifacts without runtime provenance", () => {
  const f = fixture();
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    fs.writeFileSync(path.join(f.targetDir, "models-store.json"), "user-created\n", { mode: 0o600 });
    migration.rollbackPiProfileMigration(plan.state);
    assert.equal(fs.existsSync(path.join(f.targetDir, "models-store.json")), true);
    assert.equal(fs.readFileSync(path.join(f.targetDir, "models-store.json"), "utf8"), "user-created\n");
  } finally { clean(f); }
});

test("refuses target content or mode tampering during rollback", () => {
  const f = fixture();
  try {
    const plan = migration.preparePiProfileMigration(f.env, f.config, f.agent);
    migration.applyPiProfileMigration(plan);
    fs.appendFileSync(path.join(f.targetDir, "models.json"), "tampered");
    assert.throws(() => migration.rollbackPiProfileMigration(plan.state), /changed/);
    assert.equal(fs.existsSync(f.targetDir), true);

    const second = fixture();
    try {
      const secondPlan = migration.preparePiProfileMigration(second.env, second.config, second.agent);
      migration.applyPiProfileMigration(secondPlan);
      fs.chmodSync(path.join(second.targetDir, "models.json"), 0o644);
      assert.throws(() => migration.rollbackPiProfileMigration(secondPlan.state), /changed/);
    } finally { clean(second); }
  } finally { clean(f); }
});

function lockPath(config, agent) {
  return path.join(config, "providers", "pi", `${agent}.larkin-pi-import.lock`);
}

function writeLock(config, agent, body, mode = 0o600) {
  const file = lockPath(config, agent);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.equal(typeof pid, "number");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

test("reclaims a stale lock whose recorded pid is dead", async () => {
  const f = fixture();
  try {
    const file = writeLock(f.config, f.agent, `${await deadPid()}\n`);
    migration.clearStalePiProfileMigrationLock(f.config, f.agent);
    assert.equal(fs.existsSync(file), false);
  } finally { clean(f); }
});

test("refuses to reclaim a lock owned by the current live pid", () => {
  const f = fixture();
  try {
    const file = writeLock(f.config, f.agent, `${process.pid}\n`);
    assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent), /Pi provider target is busy/);
    assert.equal(fs.existsSync(file), true);
  } finally { clean(f); }
});

test("treats EPERM as a possibly live lock and refuses reclaim", async () => {
  const f = fixture();
  try {
    const file = writeLock(f.config, f.agent, `${await deadPid()}\n`);
    const kill = () => {
      const error = new Error("EPERM");
      error.code = "EPERM";
      throw error;
    };
    assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent, { kill }), /Pi provider target is busy/);
    assert.equal(fs.existsSync(file), true);
  } finally { clean(f); }
});

test("refuses malformed lock pid lines", () => {
  const f = fixture();
  try {
    for (const body of ["", "not-a-pid\n", "0\n", "-3\n", "12\n34\n", "12 34\n"]) {
      const file = writeLock(f.config, f.agent, body);
      assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent), /Pi provider target is busy/, body);
      assert.equal(fs.existsSync(file), true, body);
    }
  } finally { clean(f); }
});

test("refuses symlink or hardlinked lock metadata", async () => {
  const f = fixture();
  try {
    const pid = await deadPid();
    const file = lockPath(f.config, f.agent);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const target = path.join(f.config, "providers", "pi", "lock-target");
    fs.writeFileSync(target, `${pid}\n`, { mode: 0o600 });
    fs.symlinkSync(target, file);
    assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent), /Pi provider target is busy/);
    fs.unlinkSync(file);
    writeLock(f.config, f.agent, `${pid}\n`, 0o644);
    assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent), /Pi provider target is busy/);
    fs.unlinkSync(file);
    writeLock(f.config, f.agent, `${pid}\n`);
    fs.linkSync(file, `${file}.hard`);
    assert.throws(() => migration.clearStalePiProfileMigrationLock(f.config, f.agent), /Pi provider target is busy/);
  } finally { clean(f); }
});

test("concurrent stale-lock reclaimers leave the lock path empty without stealing a live lock", async () => {
  const f = fixture();
  try {
    const file = writeLock(f.config, f.agent, `${await deadPid()}\n`);
    const script = path.join(f.root, "reclaim.mjs");
    fs.writeFileSync(script, `import { pathToFileURL } from "node:url";
const migration = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, "dist/runtime/pi-profile-migration.mjs"))}).href);
try {
  migration.clearStalePiProfileMigrationLock(process.env.LOCK_CONFIG, process.env.LOCK_AGENT);
  process.stdout.write("ok\\n");
} catch (error) {
  process.stdout.write(String(error && error.message || error) + "\\n");
  process.exit(2);
}
`);
    const env = { ...process.env, LOCK_CONFIG: f.config, LOCK_AGENT: f.agent };
    const first = spawn(process.execPath, [script], { env, encoding: "utf8" });
    const second = spawn(process.execPath, [script], { env, encoding: "utf8" });
    const results = await Promise.all([first, second].map((child) => new Promise((resolve) => {
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("exit", (status) => resolve({ status, stdout, stderr }));
    })));
    assert.equal(results.every((result) => result.status === 0 && result.stdout.includes("ok")), true, JSON.stringify(results));
    assert.equal(fs.existsSync(file), false);
  } finally { clean(f); }
});
