import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const { isChannelReconnecting, projectAgentReadiness } = await import(pathToFileURL(path.join(ROOT, "dist/app/agent-readiness.mjs")).href);

const daemon = {
  state: "owned",
  running: true,
  pid: 42,
  startedAt: "2026-07-29T01:00:00.000Z",
  agents: ["cli_ready"],
};

test("agent readiness requires the current owned daemon, ready Runtime, connected channel, and no reconnect", () => {
  const ready = projectAgentReadiness({
    agentId: "cli_ready",
    daemon,
    status: {
      connectedAt: "2026-07-29T01:00:01.000Z",
      connectedVia: "channel",
      inboundVerifiedAt: "2026-07-29T01:00:02.000Z",
      reconnectingAt: null,
      runtimeReadiness: { state: "ready" },
    },
  });
  assert.deepEqual(ready, {
    ready: true,
    readiness: {
      daemon_owned: true,
      runtime_ready: true,
      channel_connected: true,
      channel_not_reconnecting: true,
    },
    channel: {
      connected_at: "2026-07-29T01:00:01.000Z",
      connected_via: "channel",
      inbound_verified_at: "2026-07-29T01:00:02.000Z",
    },
  });
});

test("stale channels, unready Runtimes, foreign daemons, and active reconnects stay false", () => {
  const variants = [
    { status: { connectedAt: "2026-07-29T00:59:59.999Z", connectedVia: "channel", runtimeReadiness: { state: "ready" } }, field: "channel_connected" },
    { status: { connectedAt: "2026-07-29T00:59:00.000Z", runtimeReadiness: { state: "ready" } }, field: "channel_connected" },
    { status: { connectedAt: "2026-07-29T01:00:01.000Z", runtimeReadiness: { state: "incompatible" } }, field: "runtime_ready" },
    { daemon: { ...daemon, agents: ["cli_other"] }, status: { connectedAt: "2026-07-29T01:00:01.000Z", runtimeReadiness: { state: "ready" } }, field: "daemon_owned" },
    {
      status: {
        connectedAt: "2026-07-29T01:00:01.000Z",
        runtimeReadiness: { state: "ready" },
        reconnectingAt: "2026-07-29T01:00:03.000Z",
        reconnectedAt: "2026-07-29T01:00:02.000Z",
      },
      field: "channel_not_reconnecting",
    },
  ];
  for (const variant of variants) {
    const result = projectAgentReadiness({
      agentId: "cli_ready",
      daemon: variant.daemon ?? daemon,
      status: variant.status,
    });
    assert.equal(result.ready, false, variant.field);
    assert.equal(result.readiness[variant.field], false, variant.field);
  }
});

test("a newer current connection clears older reconnect markers", () => {
  const status = {
    connectedAt: "2026-07-29T01:00:04.000Z",
    connectedVia: "channel",
    runtimeReadiness: { state: "ready" },
    reconnectingAt: "2026-07-29T01:00:03.000Z",
    reconnectedAt: "2026-07-29T01:00:02.000Z",
  };
  assert.equal(isChannelReconnecting(status), false);
  assert.equal(isChannelReconnecting({ ...status, reconnectingAt: "2026-07-29T01:00:05.000Z" }), true);
  const result = projectAgentReadiness({
    agentId: "cli_ready",
    daemon,
    status,
  });
  assert.equal(result.ready, true);
  assert.equal(result.readiness.channel_not_reconnecting, true);
});
