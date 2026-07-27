import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createReminderRoutes } = require(path.join(ROOT, "dist/agent/reminder-routes.cjs"));

function fixture(temp) {
  const logs = [];
  let current = Date.parse("2026-07-16T00:00:00.000Z");
  const routes = createReminderRoutes({
    stateFile: path.join(temp, "reminders.json"),
    agentId: "cli_contract",
    query: (requestPath, name) => new URL(requestPath, "http://local").searchParams.get(name),
    log: (...parts) => logs.push(parts),
    now: () => current,
    timeZone: () => "Asia/Shanghai",
  });
  return {
    request(method, requestPath, body = {}) {
      return routes.handle({ path: requestPath, pathNoQuery: requestPath.split("?")[0], method, body });
    },
    advance(ms) { current += ms; },
    logs,
  };
}

test("reminder route service preserves schedule/list/snooze/update/cancel schemas and persistence", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-routes-"));
  try {
    const f = fixture(temp);
    const scheduled = f.request("POST", "/reminders", { title: "follow up", delaySeconds: 60, msgId: "om_1" });
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.data.reminder.fireAt, "2026-07-16T00:01:00.000Z");
    assert.equal(scheduled.data.reminder.recurrence, null);
    const id = scheduled.data.reminder.reminderId;
    const stored = JSON.parse(fs.readFileSync(path.join(temp, "reminders.json"), "utf8"));
    assert.equal(stored.reminders[0].tz, null);
    assert.equal(stored.reminders[0].version, 1);
    assert.equal(stored.reminders[0].events[0].eventType, "scheduled");

    assert.equal(f.request("GET", "/reminders").data.reminders.length, 1);
    f.advance(5_000);
    const snoozed = f.request("POST", `/reminders/${id}/snooze`, { delaySeconds: 30 });
    assert.equal(snoozed.data.reminder.fireAt, "2026-07-16T00:00:35.000Z");
    const updated = f.request("PATCH", `/reminders/${id}`, { title: "renamed" });
    assert.equal(updated.data.reminder.title, "renamed");
    const canceled = f.request("DELETE", `/reminders/${id}`);
    assert.equal(canceled.data.reminder.status, "canceled");
    assert.equal(f.request("GET", "/reminders").data.reminders.length, 0);
    assert.equal(f.request("GET", "/reminders?all=true").data.reminders.length, 1);
    assert.deepEqual(f.request("GET", `/reminders/${id}/log`).data.events.map((event) => event.eventType), ["scheduled", "snoozed", "updated", "canceled"]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("reminder route service preserves validation and recurrence behavior", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-validation-"));
  try {
    const f = fixture(temp);
    assert.equal(f.request("POST", "/reminders", {}).status, 400);
    assert.equal(f.request("POST", "/reminders", { title: "bad", fireAt: "not-a-date" }).status, 400);
    assert.equal(f.request("POST", "/reminders", { title: "bad", repeat: "every:10s" }).status, 400);
    const recurring = f.request("POST", "/reminders", { title: "daily", repeat: "daily@09:00", tz: "Asia/Shanghai" });
    assert.equal(recurring.ok, true);
    assert.deepEqual(recurring.data.reminder.recurrence, { kind: "daily", description: "daily@09:00 (Asia/Shanghai)" });
    assert.equal(f.request("POST", "/reminders/missing/snooze", { delaySeconds: 0 }).status, 400);
    assert.equal(f.request("DELETE", "/reminders/missing").status, 404);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("TypeScript dispatcher keeps wire authority while delegating reminder business logic", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  assert.match(source, /async function handle\(input: AgentTransportInput\)/);
  assert.match(source, /if \(\/\\\/reminders\(\\\/\|\$\)\/\.test\(pathNoQ\)\) \{/);
  assert.match(source, /return reminderRoutes\.handle\(\{ path: p, pathNoQuery: pathNoQ, method, body \}\)/);
  assert.match(source, /request: \(input: AgentTransportInput\) => handle\(input\)/);
  assert.match(source, /requestMultipart: async \(_method: unknown, pathname: unknown, form: MultipartForm \| null \| undefined\)/);
  assert.doesNotMatch(source, /R\.parseRepeat|R\.mutate|require\(["']\.\/reminder-store\.cjs["']\)/);
});
