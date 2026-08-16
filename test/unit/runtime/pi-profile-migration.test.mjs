import assert from "node:assert/strict";
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
  fs.writeFileSync(version, `#!${process.execPath}\nconsole.log("0.84.2")\n`, { mode: 0o700 });
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
  return { root, source, config, targetDir, agent, env, auth, models };
}

function clean(f) { fs.rmSync(f.root, { recursive: true, force: true }); }

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
