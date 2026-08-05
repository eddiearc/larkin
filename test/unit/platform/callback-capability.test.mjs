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

test("existing bot capability grant atomically records callback and document-comment requests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-capabilities-"));
  const appId = "cli_capabilitiesA1";
  try {
    const bots = path.join(root, "bots");
    fs.mkdirSync(bots, { mode: 0o700 });
    const file = path.join(bots, `${appId}.json`);
    fs.writeFileSync(file, JSON.stringify({ appId, appSecret: "fixture", tenant: "feishu", retained: true }), { mode: 0o600 });
    const marked = capability.markSetupCapabilitiesRequested(root, appId, Date.parse("2026-08-05T00:00:00.000Z"));
    assert.equal(marked.documentCommentEvent.status, "requested-unverified");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.retained, true);
    assert.deepEqual(stored.capabilities.documentCommentEvent, {
      status: "requested-unverified",
      event: "drive.notice.comment_add_v1",
      scope: "drive:drive",
      requestedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.deepEqual(stored.capabilities.documentCommentReply, {
      status: "requested-unverified",
      scope: "docs:document.comment:create",
      requestedAt: "2026-08-05T00:00:00.000Z",
    });
    assert.equal(capability.documentCommentReplyCapability(stored).scope, "docs:document.comment:create");
    assert.equal(capability.documentCommentCapability(stored).status, "requested-unverified");
    assert.deepEqual(capability.effectiveDocumentCommentSubscription(stored), {
      mode: "none", status: "safe-default", source: "setup-default", dimension: null,
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(bots).filter((name) => name.endsWith(".tmp")), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("comment subscription migration is safe and broad mode requires a matching platform verification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-comment-subscription-"));
  const appId = "cli_subscriptionA1";
  try {
    const bots = path.join(root, "bots");
    fs.mkdirSync(bots, { mode: 0o700 });
    const file = path.join(bots, `${appId}.json`);
    fs.writeFileSync(file, JSON.stringify({ appId, appSecret: "fixture", tenant: "feishu" }), { mode: 0o600 });
    assert.deepEqual(capability.readDocumentCommentSubscription(root, appId), {
      mode: "none", status: "safe-default", source: "legacy-default", dimension: null,
    });
    const marked = capability.markSetupCapabilitiesRequested(
      root, appId, Date.parse("2026-08-05T00:00:00.000Z"), "application",
    );
    assert.deepEqual(marked.documentCommentSubscription, {
      mode: "none", status: "requested-unverified", source: "setup-opt-in", dimension: "application",
      requestedAt: "2026-08-05T00:00:00.000Z",
    });
    const forgedUser = JSON.parse(fs.readFileSync(file, "utf8"));
    forgedUser.capabilities.documentCommentSubscription.dimension = "user";
    assert.equal(capability.documentCommentSubscriptionCapability(forgedUser), null);
    capability.markDocumentCommentSubscriptionVerified(
      root, appId, "application", Date.parse("2026-08-05T00:01:00.000Z"),
    );
    assert.deepEqual(capability.readDocumentCommentSubscription(root, appId), {
      mode: "subscribed", status: "platform-verified", source: "platform-status", dimension: "application",
    });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
