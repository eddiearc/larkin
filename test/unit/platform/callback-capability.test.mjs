import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import * as capability from "../../../dist/platform/callback-capability.mjs";

test("callback readiness stays fail-closed until a matching real-event probe is verified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-callback-capability-"));
  const appId = "cli_callbackA1";
  try {
    const bots = path.join(root, "bots");
    fs.mkdirSync(bots, { mode: 0o700 });
    const file = path.join(bots, `${appId}.json`);
    fs.writeFileSync(file, JSON.stringify({ appId, appSecret: "fixture", tenant: "feishu", capabilities: {
      cardActionCallback: { status: "requested-unverified", requestedAt: "2026-07-23T00:00:00.000Z" },
    } }), { mode: 0o600 });
    assert.equal(capability.readCallbackCapability(root, appId).status, "requested-unverified");
    const issued = capability.issueCallbackProbe(root, appId, Date.parse("2026-07-23T00:01:00.000Z"), () => "a".repeat(32));
    assert.equal(issued.capability.status, "probe-issued");
    assert.equal(capability.verifyCallbackProbe(root, appId, "b".repeat(32), "evt_wrong"), false);
    assert.equal(capability.readCallbackCapability(root, appId).status, "probe-issued");
    assert.equal(capability.verifyCallbackProbe(root, appId, issued.nonce, "evt_real", Date.parse("2026-07-23T00:02:00.000Z")), true);
    const verified = capability.readCallbackCapability(root, appId);
    assert.equal(verified.status, "verified-effective");
    assert.equal(verified.verifiedEventId, "evt_real");
    assert.equal(capability.issueCallbackProbe(root, appId).capability.status, "verified-effective");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
