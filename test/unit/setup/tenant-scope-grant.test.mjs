import assert from "node:assert/strict";
import { test } from "bun:test";
import { missingGrantedTenantScopes } from "../../../src/setup/tenant-scope-grant.ts";

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
