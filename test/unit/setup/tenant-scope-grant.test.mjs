import assert from "node:assert/strict";
import { test } from "bun:test";
import { missingGrantedTenantScopes, reconcileTenantScopes } from "../../../src/setup/tenant-scope-grant.ts";

test("missingGrantedTenantScopes requires grant_status 1 for group_msg", () => {
  assert.deepEqual(missingGrantedTenantScopes({ data: { scopes: [] } }), ["im:message.group_msg"]);
  assert.deepEqual(missingGrantedTenantScopes({
    data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 0 }] },
  }), ["im:message.group_msg"]);
  assert.deepEqual(missingGrantedTenantScopes({
    data: { scopes: [
      { scope_name: "im:message:readonly", grant_status: 1 },
      { scope_name: "im:message.group_msg", grant_status: 1 },
    ] },
  }), []);
  assert.deepEqual(missingGrantedTenantScopes(null), ["im:message.group_msg"]);
  assert.deepEqual(missingGrantedTenantScopes("{not-json"), ["im:message.group_msg"]);
  assert.deepEqual(missingGrantedTenantScopes({ data: {} }), ["im:message.group_msg"]);
  assert.deepEqual(missingGrantedTenantScopes({
    data: { scopes: [{ grant_status: 1 }] },
  }), ["im:message.group_msg"]);
});

test("grant reconciliation distinguishes required and optional while rejecting invalid API envelopes", () => {
  const requested = ["im:message.group_msg", "search:message", "drive:drive"];
  const payload = { code: 0, data: { scopes: [
    { scope_name: "im:message.group_msg", grant_status: 1 },
    { scope_name: "search:message", grant_status: "1" },
    { scope_name: "drive:drive", grant_status: 0 },
  ] } };
  assert.deepEqual(reconcileTenantScopes(payload, requested), {
    verified: true, missingRequired: [], missingOptional: ["search:message", "drive:drive"],
  });
  for (const invalid of [null, {}, { ...payload, code: 999 }, { ...payload, ok: false }]) {
    assert.deepEqual(reconcileTenantScopes(invalid, requested), {
      verified: false, missingRequired: ["im:message.group_msg"], missingOptional: ["search:message", "drive:drive"],
    });
  }
});
