import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = pathToFileURL(path.join(ROOT, "dist/setup/tenant-scope-grant.mjs")).href;

test("optional scope impacts group missing scopes by capability in declaration order", async () => {
  const { missingOptionalScopeImpacts } = await import(MODULE);
  assert.deepEqual(
    missingOptionalScopeImpacts(["im:chat.members:read", "drive:drive", "im:chat:readonly", "search:message"]),
    [
      "群与成员信息（成员姓名/群名解析）：im:chat:readonly, im:chat.members:read",
      "云文档评论事件与回复：drive:drive",
      "机器人消息搜索：search:message",
    ],
  );
});

test("optional scope impacts keep an empty input empty and surface unbucketed scopes as 其他", async () => {
  const { missingOptionalScopeImpacts } = await import(MODULE);
  assert.deepEqual(missingOptionalScopeImpacts([]), []);
  assert.deepEqual(
    missingOptionalScopeImpacts(["application:application:self_manage"]),
    ["其他权限：application:application:self_manage"],
  );
});
