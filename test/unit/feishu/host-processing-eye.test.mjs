import assert from "node:assert/strict";
import { test } from "bun:test";
import { ProcessingEyeOrchestrator } from "../../../dist/feishu/host-processing-eye.mjs";

const agent = { agentId: "cli_eye", name: "cli_eye", feishuProfile: "cli_eye" };

function createTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = { callback, delay, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cancelled = true; },
    run(timer, { evenIfCancelled = false } = {}) {
      if (timer.fired || (timer.cancelled && !evenIfCancelled)) return;
      timer.fired = true;
      timer.callback();
    },
    active(delay) { return timers.filter((timer) => timer.delay === delay && !timer.cancelled && !timer.fired); },
  };
}

function createHarness({ deferPosts = false, readPending } = {}) {
  const calls = [], writes = [], logs = [], postCallbacks = [];
  const timers = createTimers();
  let reaction = 0;
  const eye = new ProcessingEyeOrchestrator({
    cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      if (args.includes("POST")) {
        const complete = () => callback(null, JSON.stringify({ data: { reaction_id: `react_${++reaction}` } }), "");
        if (deferPosts) postCallbacks.push(complete);
        else complete();
      } else callback(null, JSON.stringify({ ok: true }), "");
      return {};
    },
    readPending,
    writePending(_agent, items) { writes.push(structuredClone(items)); },
    log(...parts) { logs.push(parts.join(" ")); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const deletes = () => calls.filter(({ args }) => args.includes("DELETE"));
  return { eye, calls, deletes, writes, logs, postCallbacks, timers };
}

for (const [runtime, sequence] of [
  ["Codex", ["working", "text", "internal", "idle"]],
  ["Claude Code", ["working", "thinking", "text", "tool", "idle"]],
  ["Pi", ["working", "thinking", "text", "tool", "internal", "idle"]],
]) {
  test(`processing eye waits for idle grace across ${runtime} intermediate activities`, () => {
    const { eye, deletes, timers, writes } = createHarness();
    eye.add(agent, `om_${runtime.replaceAll(" ", "_")}`);
    for (const activity of sequence) {
      eye.observeActivity(agent, activity);
      assert.equal(deletes().length, 0, `${activity} must not clear before grace`);
    }
    assert.equal(timers.active(1_000).length, 1);
    timers.run(timers.active(1_000)[0]);
    assert.equal(deletes().length, 1);
    assert.deepEqual(writes.at(-1), []);
  });
}

test("duplicate idle schedules one completion and new activity cancels stale completion", () => {
  const { eye, deletes, timers } = createHarness();
  eye.add(agent, "om_duplicate");
  eye.observeActivity(agent, "working");
  eye.observeActivity(agent, "idle");
  eye.observeActivity(agent, "idle");
  assert.equal(timers.active(1_000).length, 1);
  const stale = timers.active(1_000)[0];
  eye.observeActivity(agent, "tool");
  assert.equal(stale.cancelled, true);
  timers.run(stale, { evenIfCancelled: true });
  assert.equal(deletes().length, 0, "a cancelled callback must be generation-safe");
  eye.observeActivity(agent, "idle");
  assert.equal(timers.active(1_000).length, 1);
  timers.run(timers.active(1_000)[0]);
  assert.equal(deletes().length, 1);
});

test("activity observed before add remains active and clears on the following idle", () => {
  const { eye, deletes, timers } = createHarness();
  eye.observeActivity(agent, "working");
  eye.add(agent, "om_activity_first");
  eye.observeActivity(agent, "idle");
  assert.equal(timers.active(1_000).length, 1);
  timers.run(timers.active(1_000)[0]);
  assert.equal(deletes().length, 1);
});

test("add during idle grace establishes a new active generation without another intermediate event", () => {
  const { eye, deletes, timers } = createHarness();
  eye.add(agent, "om_first_turn");
  eye.observeActivity(agent, "idle");
  const stale = timers.active(1_000)[0];
  eye.add(agent, "om_second_turn");
  assert.equal(stale.cancelled, true);
  eye.observeActivity(agent, "idle");
  const current = timers.active(1_000)[0];
  assert.ok(current);
  timers.run(stale, { evenIfCancelled: true });
  assert.equal(deletes().length, 0);
  timers.run(current);
  assert.equal(deletes().length, 2);
});

test("new add cancels old idle grace and late POST receipt self-deletes", () => {
  const { eye, deletes, postCallbacks, timers } = createHarness({ deferPosts: true });
  eye.add(agent, "om_old");
  postCallbacks.shift()();
  eye.observeActivity(agent, "working");
  eye.observeActivity(agent, "idle");
  const staleCompletion = timers.active(1_000)[0];

  eye.add(agent, "om_new");
  assert.equal(staleCompletion.cancelled, true);
  timers.run(staleCompletion, { evenIfCancelled: true });
  assert.equal(deletes().length, 0, "old completion must not clear the new generation");

  eye.clear(agent, "fast");
  assert.equal(deletes().length, 1, "the already persisted old reaction is cleared");
  postCallbacks.shift()();
  assert.equal(deletes().length, 2, "the late new POST receipt self-deletes");
  assert.match(deletes().at(-1).args.at(-1), /react_2$/);
});

test("new add advances generation so an older POST receipt cannot become pending", () => {
  const { eye, deletes, postCallbacks, timers, writes } = createHarness({ deferPosts: true });
  eye.add(agent, "om_first");
  eye.add(agent, "om_second");
  postCallbacks.shift()();
  assert.equal(deletes().length, 1);
  assert.match(deletes()[0].args.at(-1), /react_1$/);
  postCallbacks.shift()();
  assert.deepEqual(writes.at(-1), [{ msgId: "om_second", reactionId: "react_2" }]);
  eye.observeActivity(agent, "working");
  eye.observeActivity(agent, "idle");
  timers.run(timers.active(1_000)[0]);
  assert.equal(deletes().length, 2);
  assert.match(deletes().at(-1).args.at(-1), /react_2$/);
});

test("idle without an add or observed active activity does not schedule completion", () => {
  const { eye, deletes, timers } = createHarness();
  eye.observeActivity(agent, "idle");
  assert.equal(timers.active(1_000).length, 0);
  assert.equal(deletes().length, 0);
});

test("error and offline clear immediately while fallback remains 15 minutes", () => {
  for (const terminal of ["error", "offline"]) {
    const { eye, deletes } = createHarness();
    eye.add(agent, `om_${terminal}`);
    eye.observeActivity(agent, "working");
    eye.observeActivity(agent, terminal);
    assert.equal(deletes().length, 1, terminal);
  }

  const { eye, deletes, timers } = createHarness();
  eye.add(agent, "om_fallback");
  const fallback = timers.active(15 * 60 * 1_000)[0];
  assert.ok(fallback);
  timers.run(fallback);
  assert.equal(deletes().length, 1);
});

test("unknown non-terminal activity preserves the reaction until explicit idle", () => {
  const { eye, deletes, timers } = createHarness();
  eye.add(agent, "om_unknown");
  eye.observeActivity(agent, "working");
  eye.observeActivity(agent, "future-runtime-activity");
  assert.equal(deletes().length, 0);
  eye.observeActivity(agent, "idle");
  timers.run(timers.active(1_000)[0]);
  assert.equal(deletes().length, 1);
});

test("startup leftovers are cleared", () => {
  const { eye, deletes, writes } = createHarness({ readPending: () => [{ msgId: "om_old", reactionId: "react_old" }] });
  eye.restoreAndClear(agent);
  assert.equal(deletes().length, 1);
  assert.match(deletes()[0].args.at(-1), /react_old$/);
  assert.deepEqual(writes, [[]]);
});

test("failed reaction POST never becomes pending and terminal cleanup remains harmless", () => {
  const calls = [], writes = [], logs = [];
  const timers = createTimers();
  const eye = new ProcessingEyeOrchestrator({
    cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
    execFile(_command, args, _options, callback) {
      calls.push(args);
      callback(null, JSON.stringify({ ok: false, error: { message: "denied" } }), "");
      return {};
    },
    writePending(_agent, items) { writes.push(structuredClone(items)); },
    log(...parts) { logs.push(parts.join(" ")); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  eye.add(agent, "om_post_failed");
  eye.observeActivity(agent, "idle");
  timers.run(timers.active(1_000)[0]);
  assert.equal(calls.filter((args) => args.includes("DELETE")).length, 0);
  assert.deepEqual(writes, []);
  assert.match(logs.join("\n"), /点上失败/);
});

test("non-reaction larkApi failure records exit code and stderr head instead of echoing the command line", () => {
  const errors = [];
  const eye = new ProcessingEyeOrchestrator({
    cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
    execFile(_command, _args, _options, callback) {
      const error = Object.assign(
        new Error("Command failed: lark-cli --profile cli_eye api POST /open-apis/im/v1/messages/om_fail/reactions --data {}"),
        { code: 1 },
      );
      callback(error, "", "FetchError: request to https://open.feishu.cn failed, reason: socket hang up\n");
      return {};
    },
    recordStatusError(_agent, text) { errors.push(text); },
    writePending() {}, setTimer: () => ({ fake: true }), clearTimer() {},
  });
  eye.larkApi(agent, "GET", "/open-apis/im/v1/messages/om_fail", null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^larkApi GET messages\/om_fail: exit=1 \| FetchError: request to/);
  assert.doesNotMatch(errors[0], /Command failed/);
});

test("processing reaction timeout stays in best-effort diagnostics instead of generic status errors", () => {
  const errors = [], logs = [];
  const eye = new ProcessingEyeOrchestrator({
    cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
    execFile(_command, _args, _options, callback) {
      callback(Object.assign(new Error("timed out"), { killed: true, code: "ETIMEDOUT" }), "", "");
      return {};
    },
    recordStatusError(_agent, text) { errors.push(text); },
    log(...parts) { logs.push(parts.join(" ")); },
    writePending() {}, setTimer: () => ({ fake: true }), clearTimer() {},
  });
  eye.add(agent, "om_timeout");
  assert.deepEqual(errors, []);
  assert.match(logs.join("\n"), /超时/);
});

test("larkApi failure without stderr falls back to stdout head", () => {
  const errors = [];
  const eye = new ProcessingEyeOrchestrator({
    cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
    execFile(_command, _args, _options, callback) {
      callback(Object.assign(new Error("Command failed: lark-cli …"), { code: "ENOENT" }), "partial garbage output", "");
      return {};
    },
    recordStatusError(_agent, text) { errors.push(text); },
    writePending() {}, setTimer: () => ({ fake: true }), clearTimer() {},
  });
  eye.larkApi(agent, "GET", "/open-apis/im/v1/messages/om_fail2", null);
  assert.match(errors[0], /exit=ENOENT \| partial garbage output/);
});

test("idle completion replaces the 👀 reaction with a ✅ DONE reaction (#70)", () => {
  const { eye, calls, deletes, logs, timers } = createHarness();
  eye.add(agent, "om_done");
  eye.observeActivity(agent, "working");
  eye.observeActivity(agent, "idle");
  timers.run(timers.active(1_000)[0]);
  assert.equal(deletes().length, 1);
  const donePosts = calls.filter(({ args }) => args.includes("POST") && args.some((arg) => typeof arg === "string" && arg.includes("DONE")));
  assert.equal(donePosts.length, 1);
  assert.match(donePosts[0].args.at(-1), /"emoji_type"\s*:\s*"DONE"/);
  assert.match(logs.join("\n"), /已完成/);
});

test("error, offline, and fallback clears never add a DONE reaction", () => {
  for (const terminal of ["error", "offline"]) {
    const { eye, calls, deletes } = createHarness();
    eye.add(agent, `om_${terminal}`);
    eye.observeActivity(agent, "working");
    eye.observeActivity(agent, terminal);
    assert.equal(deletes().length, 1, terminal);
    assert.equal(calls.filter(({ args }) => args.some((arg) => typeof arg === "string" && arg.includes("DONE"))).length, 0, terminal);
  }

  const { eye, calls, deletes, timers } = createHarness();
  eye.add(agent, "om_fallback_done");
  timers.run(timers.active(15 * 60 * 1_000)[0]);
  assert.equal(deletes().length, 1);
  assert.equal(calls.filter(({ args }) => args.some((arg) => typeof arg === "string" && arg.includes("DONE"))).length, 0);
});
