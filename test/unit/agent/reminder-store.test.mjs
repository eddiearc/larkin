import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNTIME = path.join(ROOT, "dist", "agent", "reminder-store.cjs");
const BUILT = path.join(ROOT, "dist", "agent", "reminder-store.cjs");

test("reminder store authority is strict TypeScript compiled to the direct CJS entry point", () => {
  const runtime = fs.readFileSync(RUNTIME, "utf8");
  assert.match(runtime, /function\s+(withLock|load|save|mutate|parseRepeat|toSummary|appendEvent)/);
  assert.doesNotMatch(runtime, /packages\/larkin-shell|fork\/feishu/);
  assert.equal(fs.existsSync(path.join(ROOT, "src", "agent", "reminder-store.ts")), true);
  assert.equal(fs.existsSync(BUILT), true);
  assert.deepEqual(Object.keys(require(RUNTIME)).sort(), [
    "appendEvent", "load", "mutate", "newId", "nowIso", "parseRepeat", "save", "toSummary", "withLock",
  ]);
});

test("load/save/mutate preserve schema fallback, atomic replacement, and rollback on callback failure", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-store-"));
  try {
    const store = require(RUNTIME);
    const file = path.join(temp, "reminders.json");
    assert.deepEqual(store.load(file), { reminders: [] });
    fs.writeFileSync(file, "damaged json");
    assert.deepEqual(store.load(file), { reminders: [] });
    fs.writeFileSync(`${file}.tmp`, "orphaned crash temporary");
    store.save(file, { reminders: [], generation: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { reminders: [], generation: 1 });
    assert.equal(fs.existsSync(`${file}.tmp`), false, "a prior crash temporary must be replaced and consumed");

    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => store.mutate(file, (current) => {
      current.reminders.push({ reminderId: "must-not-commit" });
      throw new Error("abort transaction");
    }), /abort transaction/);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a failed mutator must not persist partial state");
    assert.equal(fs.existsSync(`${file}.lock`), false, "the lock must release when a mutator throws");

    const result = store.mutate(file, (current) => {
      current.reminders.push({ reminderId: "committed" });
      return "result-value";
    });
    assert.equal(result, "result-value");
    assert.deepEqual(store.load(file).reminders, [{ reminderId: "committed" }]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("the directory lock serializes independent processes and reclaims a crash-stale owner", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-concurrency-"));
  try {
    const store = require(RUNTIME);
    const file = path.join(temp, "reminders.json");
    store.save(file, { reminders: [], counter: 0 });
    const childSource = `
const store = require(process.env.REMINDER_STORE_MODULE);
store.mutate(process.env.REMINDER_STORE_FILE, (current) => {
  const observed = Number(current.counter || 0);
  const until = Date.now() + 25;
  while (Date.now() < until) {}
  current.counter = observed + 1;
});
`;
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, ["--eval", childSource], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, REMINDER_STORE_MODULE: BUILT, REMINDER_STORE_FILE: file },
    }));
    const exits = await Promise.all(children.map(async (child) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const [code, signal] = await once(child, "exit");
      return { code, signal, stderr };
    }));
    assert.deepEqual(exits.map(({ code, signal }) => ({ code, signal })), Array(8).fill({ code: 0, signal: null }),
      exits.map((exit) => exit.stderr).join("\n"));
    assert.equal(store.load(file).counter, 8, "no cross-process read-modify-write update may be lost");

    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir);
    const stale = new Date(Date.now() - 20_000);
    fs.utimesSync(lockDir, stale, stale);
    store.mutate(file, (current) => { current.recoveredAfterCrash = true; });
    assert.equal(store.load(file).recoveredAfterCrash, true);
    assert.equal(fs.existsSync(lockDir), false, "a lock abandoned by a crashed process must be reclaimed");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("recurrence calculations preserve interval anchors and UTC wall-clock schedules", () => {
  const store = require(RUNTIME);
  const interval = store.parseRepeat("every:15m", "UTC");
  assert.deepEqual({ kind: interval.kind, description: interval.description }, { kind: "interval", description: "every 15m" });
  assert.equal(interval.next(31 * 60_000, 0), 45 * 60_000);
  assert.match(store.parseRepeat("every:30s", "UTC").error, /至少 1 分钟/);

  const daily = store.parseRepeat("daily@09:00", "UTC");
  assert.equal(daily.next(Date.parse("2026-07-16T08:30:00.000Z")), Date.parse("2026-07-16T09:00:00.000Z"));
  assert.equal(daily.next(Date.parse("2026-07-16T09:00:00.000Z")), Date.parse("2026-07-17T09:00:00.000Z"));

  const weekly = store.parseRepeat("weekly:mon,fri@09:00", "UTC");
  assert.equal(weekly.next(Date.parse("2026-07-16T10:00:00.000Z")), Date.parse("2026-07-17T09:00:00.000Z"));
  assert.match(store.parseRepeat("weekly:bad@09:00", "UTC").error, /无效星期/);
  assert.match(store.parseRepeat("daily@25:00", "UTC").error, /无效时间/);
  assert.match(store.parseRepeat("monthly@09:00", "UTC").error, /无法识别/);
});

test("summary and event shapes retain every key required by the Agent API", () => {
  const store = require(RUNTIME);
  const reminder = {
    reminderId: "a".repeat(32),
    ownerAgentId: "cli_reminder1",
    title: "review",
    fireAt: "2026-07-17T09:00:00.000Z",
    createdAt: "2026-07-16T09:00:00.000Z",
    status: "scheduled",
    repeat: "daily@09:00",
    tz: "UTC",
  };
  const summary = store.toSummary(reminder);
  assert.deepEqual(Object.keys(summary).sort(), [
    "createdAt", "deliveryAnchor", "deliveryMode", "deliveryTarget", "fireAt", "firedAt", "msgPermalink", "msgRef", "ownerAgentId", "recurrence", "reminderId", "status", "title",
  ]);
  assert.equal(summary.firedAt, null);
  assert.equal(summary.msgRef, null);
  assert.equal(summary.msgPermalink, null);
  assert.deepEqual(summary.recurrence, { kind: "daily", description: "daily@09:00 (UTC)" });

  const unsupported = store.toSummary({ ...reminder, repeat: "monthly@09:00" });
  assert.deepEqual(unsupported.recurrence, { kind: "unsupported", description: "monthly@09:00" });
  store.appendEvent(reminder, "scheduled", "agent", null, reminder.fireAt, Date.parse("2026-07-16T09:00:00.000Z"));
  assert.equal(reminder.events.length, 1);
  assert.deepEqual({ ...reminder.events[0], eventId: "<id>" }, {
    eventId: "<id>",
    reminderId: reminder.reminderId,
    eventType: "scheduled",
    actorType: "agent",
    actorId: null,
    occurredAt: "2026-07-16T09:00:00.000Z",
    nextFireAt: reminder.fireAt,
    metadata: null,
  });
  assert.match(reminder.events[0].eventId, /^[0-9a-f]{32}$/);
  assert.match(store.newId(), /^[0-9a-f]{32}$/);
});
