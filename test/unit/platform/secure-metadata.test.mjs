import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const secure = await import(pathToFileURL(path.join(ROOT, "dist/platform/secure-metadata.mjs")).href);

// secureWindowsDirectoryAcl 在非 win32 平台是 no-op；这里直接驱动导出的
// runWindowsDirectoryAcl（无平台守卫），用真实 icacls 输出形状验证收紧序列与回读校验。
// 所有用例注入 username=administrator 使校验确定化。
// 真实 icacls 输出格式：首行「<路径> <首条 ACE>」同行，其余 ACE 缩进另起一行。
const icaclsListing = (entries) => `${entries.map((e, i) => i === 0 ? `C:\\cfg ${e}` : `        ${e}`).join("\n")}\n\nSuccessfully processed 1 files.\n`;

const fixedUser = "administrator";

function sequenceSpawn() {
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const head = args[1];
    if (head === "/inheritance:r") return { status: 0, stdout: "", stderr: "", error: undefined };
    if (head === "/grant:r") return { status: 0, stdout: "", stderr: "", error: undefined };
    if (head === "/remove:g") return { status: 0, stdout: "", stderr: "", error: undefined };
    return { status: 0, stdout: icaclsListing([
      `${fixedUser}:(F)`,
      `${fixedUser}:(OI)(CI)(F)`,
      "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
    ]), stderr: "", error: undefined };
  };
  return { calls, spawn };
}

test("Windows ACL helper runs the tighten sequence and accepts user+SYSTEM only", () => {
  const { calls, spawn } = sequenceSpawn();
  secure.runWindowsDirectoryAcl("C:\\cfg", { spawn, label: "测试目录", username: fixedUser });
  assert.deepEqual(calls.map((c) => c.args[1]), [
    "/inheritance:r",
    "/grant:r",
    "/remove:g",
    undefined,
  ]);
  assert.equal(calls[1].args[2], "administrator:(OI)(CI)F");
  assert.equal(calls[1].args[4], "*S-1-5-18:(OI)(CI)F");
  assert.equal(calls[0].args[0], "C:\\cfg");
});

test("Windows ACL helper fails closed on any foreign ACE", () => {
  const spawn = (command, args) => {
    const head = args[1];
    if (head === undefined) {
      return { status: 0, stdout: icaclsListing([
        `${fixedUser}:(F)`,
        `${fixedUser}:(OI)(CI)(F)`,
        "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "BUILTIN\\Users:(RX)",
      ]), stderr: "", error: undefined };
    }
    return { status: 0, stdout: "", stderr: "", error: undefined };
  };
  assert.throws(() => secure.runWindowsDirectoryAcl("C:\\cfg", { spawn, label: "测试目录", username: fixedUser }), /BUILTIN\\Users/);
});

test("Windows ACL helper fails closed when icacls exits non-zero", () => {
  const spawn = () => ({ status: 1, stdout: "", stderr: "boom", error: undefined });
  assert.throws(() => secure.runWindowsDirectoryAcl("C:\\cfg", { spawn, label: "测试目录", username: fixedUser }), /icacls \/inheritance:r 退出 1/);
});

test("Windows ACL helper tolerates machine-qualified current user", () => {
  const spawn = (command, args) => {
    const head = args[1];
    if (head === undefined) {
      return { status: 0, stdout: icaclsListing([
        "EDDIE-HOME\\administrator:(F)",
        "EDDIE-HOME\\administrator:(OI)(CI)(F)",
        "*S-1-5-18:(OI)(CI)(F)",
      ]), stderr: "", error: undefined };
    }
    return { status: 0, stdout: "", stderr: "", error: undefined };
  };
  secure.runWindowsDirectoryAcl("C:\\cfg", { spawn, label: "测试目录", username: fixedUser });
});

test("local-control compiles the win32 socket branches (ACL root + placeholder binding)", () => {
  const built = fs.readFileSync(path.join(ROOT, "dist/app/local-control.mjs"), "utf8");
  assert.match(built, /WINDOWS_SOCKET_BINDING/);
  assert.match(built, /secureWindowsDirectoryAcl/);
});
