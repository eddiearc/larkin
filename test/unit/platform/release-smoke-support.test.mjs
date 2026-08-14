import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import {
  prepareRestrictedSmokePath,
  smokeArtifactEnvironment,
  smokeTerminationPlan,
} from "../../../scripts/release/smoke-support.ts";

test("Windows smoke uses only system PowerShell and Windows profile/temp variables", () => {
  const root = "C:\\Windows";
  const expectedPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const restrictedPath = prepareRestrictedSmokePath("win32", "unused", { SystemRoot: root },
    (candidate) => candidate === expectedPowerShell,
    () => { throw new Error("Windows smoke must not require symlinks"); });
  assert.equal(restrictedPath, path.win32.dirname(expectedPowerShell));
  assert.deepEqual(smokeArtifactEnvironment({
    platform: "win32",
    home: "C:\\smoke\\home",
    larkinHome: "C:\\smoke\\home\\.larkin",
    restrictedPath,
    temporaryDirectory: "C:\\smoke\\tmp",
    systemEnvironment: { SystemRoot: root },
  }), {
    HOME: "C:\\smoke\\home",
    LARKIN_HOME: "C:\\smoke\\home\\.larkin",
    LARKIN_CONFIG_DIR: "C:\\smoke\\home\\.larkin",
    PATH: restrictedPath,
    NO_COLOR: "1",
    USERPROFILE: "C:\\smoke\\home",
    TEMP: "C:\\smoke\\tmp",
    TMP: "C:\\smoke\\tmp",
    SystemRoot: root,
    WINDIR: root,
  });
});

test("Unix smoke retains a ps-only path and POSIX home/temp contract", () => {
  let linked;
  const restrictedPath = prepareRestrictedSmokePath("linux", "/smoke/bin", {},
    (candidate) => candidate === "/usr/bin/ps",
    (target, file) => { linked = { target, file }; });
  assert.equal(restrictedPath, "/smoke/bin");
  assert.deepEqual(linked, { target: "/usr/bin/ps", file: path.join("/smoke/bin", "ps") });
  const env = smokeArtifactEnvironment({
    platform: "linux", home: "/smoke/home", larkinHome: "/smoke/home/.larkin",
    restrictedPath, temporaryDirectory: "/smoke/tmp",
  });
  assert.equal(env.TMPDIR, "/smoke/tmp");
  assert.equal(env.USERPROFILE, undefined);
  assert.equal(env.PATH, "/smoke/bin");
});

test("dashboard cleanup uses taskkill tree termination on Windows and signals on Unix", () => {
  assert.deepEqual(smokeTerminationPlan("win32", 42, { SystemRoot: "C:\\Windows" }), {
    kind: "windows-tree",
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/PID", "42", "/T", "/F"],
  });
  assert.deepEqual(smokeTerminationPlan("linux", 42), {
    kind: "signals", graceful: "SIGTERM", force: "SIGKILL",
  });
  assert.throws(() => smokeTerminationPlan("win32", 0, { SystemRoot: "C:\\Windows" }), /valid pid/);
  assert.throws(() => prepareRestrictedSmokePath("win32", "unused", {}, () => true), /system root/);
});
