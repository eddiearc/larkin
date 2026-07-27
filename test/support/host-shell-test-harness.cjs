// Repository-only harness for exercising the current HostShell without starting
// a paid Runtime. It deliberately contains no daemon protocol or compatibility path.
const fs = require("node:fs");
const path = require("node:path");
const { createHostShell } = require("../../dist/feishu/host-shell.cjs");

const runtimeHost = {
  async start() {},
  async deliver(_agentId, envelope) {
    if (process.env.LARKIN_TEST_DELIVERY_FILE) {
      fs.appendFileSync(process.env.LARKIN_TEST_DELIVERY_FILE, `${JSON.stringify(envelope)}\n`);
    }
    return { status: "accepted", deliveryId: String(envelope.message_id || envelope.seq) };
  },
  async stop() {},
  async shutdown() {},
  subscribe() { return () => {}; },
};

const injected = process.env.LARKIN_TEST_HOST_MODULE
  ? require(path.resolve(process.env.LARKIN_TEST_HOST_MODULE))
  : process.env.LARKIN_TEST_CHANNEL_PACKAGE_MODULE
    ? require(path.resolve(process.env.LARKIN_TEST_CHANNEL_PACKAGE_MODULE))
  : undefined;
const channelPackage = injected?.channelPackage
  || (typeof injected?.createLarkChannel === "function" ? injected : undefined);
const execFileImpl = injected?.execFileImpl;
const reconcileAgentWorkspaceImpl = injected?.reconcileAgentWorkspaceImpl;

function fail(error) {
  console.error(error);
  process.exit(1);
}

try {
  createHostShell({
    runtimeHost,
    ...(channelPackage ? { channelPackage } : {}),
    ...(execFileImpl ? { execFileImpl } : {}),
    ...(reconcileAgentWorkspaceImpl ? { reconcileAgentWorkspaceImpl } : {}),
    eventSourceStartDelayMs: Number(process.env.LARKIN_TEST_EVENT_SOURCE_START_DELAY_MS || 2_000),
    channelDisconnectTimeoutMs: Number(process.env.LARKIN_TEST_CHANNEL_DISCONNECT_TIMEOUT_MS || 2_000),
  }).start().catch(fail);
} catch (error) {
  fail(error);
}
