import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { PiRpcClient } from "../../../dist/runtime/pi-rpc-client.mjs";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes = [];
  killed = [];
  stdin = {
    destroyed: false,
    write: (data, callback) => { this.writes.push(JSON.parse(data)); callback?.(); return true; },
    end: () => {},
  };
  kill(signal) { this.killed.push(signal); queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

class StubbornProcess extends FakeProcess {
  kill(signal) {
    this.killed.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

test("Pi RPC client uses correlated requests and accepts CRLF without splitting Unicode separators", async () => {
  const child = new FakeProcess();
  const client = new PiRpcClient(child, { requestTimeoutMs: 100 });
  const events = [];
  client.subscribe((event) => events.push(event));
  const pending = client.request("get_state");
  assert.equal(child.writes[0].type, "get_state");
  child.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "a\u2028b" } })}\r\n`);
  child.stdout.write(`${JSON.stringify({ id: child.writes[0].id, type: "response", command: "get_state", success: true, data: { sessionId: "s" } })}\n`);
  assert.deepEqual(await pending, { sessionId: "s" });
  assert.equal(events[0].assistantMessageEvent.delta, "a\u2028b");
});

test("Pi RPC client fails pending work exactly once on malformed or oversized frames", async () => {
  for (const frame of ["{broken}\n", `${"x".repeat(33)}\n`]) {
    const child = new FakeProcess();
    const client = new PiRpcClient(child, { requestTimeoutMs: 100, maxFrameBytes: 32 });
    const failures = [];
    client.subscribeFailure((error) => failures.push(error.message));
    const pending = client.request("get_state");
    child.stdout.write(frame);
    await assert.rejects(pending, /Pi RPC protocol/i);
    child.stdout.write("{broken-again}\n");
    assert.equal(failures.length, 1);
    assert.deepEqual(child.killed, ["SIGTERM"]);
  }
});

test("Pi RPC request timeout is bounded and tears down the unhealthy process", async () => {
  const child = new FakeProcess();
  const client = new PiRpcClient(child, { requestTimeoutMs: 5 });
  await assert.rejects(client.request("get_state"), /timed out/i);
  await client.close();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("Pi RPC prompt preflight outlives the short control deadline while compaction and retry make progress", async () => {
  const child = new FakeProcess();
  const client = new PiRpcClient(child, {
    requestTimeoutMs: 8,
    inputTimeoutMs: 24,
    inputProgressTimeoutMs: 36,
    inputMaxTimeoutMs: 100,
  });
  const events = [];
  client.subscribe((event) => events.push(event.type));
  const pending = client.request("prompt", { message: "private body" });
  const id = child.writes[0].id;
  await new Promise((resolve) => setTimeout(resolve, 12));
  child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "threshold" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 28));
  child.stdout.write(`${JSON.stringify({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 1_000, errorMessage: "private provider detail" })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 28));
  child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false })}\n`);
  child.stdout.write(`${JSON.stringify({ id, type: "response", command: "prompt", success: true })}\n`);
  await pending;
  assert.deepEqual(events, ["compaction_start", "summarization_retry_scheduled", "compaction_end"]);
  assert.deepEqual(child.killed, []);
  await client.close();
});

test("Pi RPC prompt progress cannot evade its absolute preflight deadline", async () => {
  const child = new FakeProcess();
  const client = new PiRpcClient(child, {
    requestTimeoutMs: 5,
    inputTimeoutMs: 12,
    inputProgressTimeoutMs: 24,
    inputMaxTimeoutMs: 45,
  });
  const interval = setInterval(() => child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "threshold" })}\n`), 8);
  try {
    await assert.rejects(client.request("prompt", { message: "private body" }), /prompt preflight timed out.*absolute 45ms/i);
    await client.close();
    assert.deepEqual(child.killed, ["SIGTERM"]);
  } finally {
    clearInterval(interval);
  }
});

test("Pi RPC failure and close share one shutdown promise that escalates a stubborn child", async () => {
  const child = new StubbornProcess();
  const client = new PiRpcClient(child, { requestTimeoutMs: 5, shutdownGraceMs: 5 });
  await assert.rejects(client.request("get_state"), /timed out/i);
  const first = client.close();
  const second = client.close();
  assert.equal(first, second, "close callers share the automatic failure shutdown promise");
  await first;
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
});
