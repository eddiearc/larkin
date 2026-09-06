import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import {
  materializeEmbeddedPiTmuxBundle,
  resolvePiTmuxExtensionArg,
} from "../../../src/runtime/pi-tmux-injection.ts";

afterEach(() => {
  delete globalThis.__LARKIN_EMBEDDED_PI_TMUX_BUNDLE__;
});

test("native Windows does not inject the tmux extension", () => {
  assert.equal(resolvePiTmuxExtensionArg({ env: {}, platform: "win32" }, () => "/tmp/pi-tmux.bundle.js"), null);
  assert.equal(resolvePiTmuxExtensionArg({ env: {}, platform: "linux" }, () => "/tmp/pi-tmux.bundle.js", () => true), "/tmp/pi-tmux.bundle.js");
});

test("missing tmux is native fallback; a missing bundle when tmux is supported is an error", () => {
  assert.equal(resolvePiTmuxExtensionArg({ env: {}, platform: "linux" }, () => null, () => false), null);
  assert.throws(() => resolvePiTmuxExtensionArg({ env: {}, platform: "linux" }, () => null, () => true), /bundle is missing/);
});

test("embedded standalone bundle materializes as a private file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-embed-"));
  try {
    globalThis.__LARKIN_EMBEDDED_PI_TMUX_BUNDLE__ = "export default function() {}";
    const file = materializeEmbeddedPiTmuxBundle(root);
    assert.equal(file, path.join(root, "providers", "pi", "extensions", "pi-tmux.bundle.js"));
    assert.equal(fs.readFileSync(file, "utf8"), "export default function() {}");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materialize refuses a symlink extensions directory and does not write outside", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-embed-dirlink-"));
  try {
    const dir = path.join(root, "providers", "pi");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside-dir");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dir, "extensions"));
    globalThis.__LARKIN_EMBEDDED_PI_TMUX_BUNDLE__ = "export default function() {}";
    assert.throws(() => materializeEmbeddedPiTmuxBundle(root), /Could not materialize/);
    assert.equal(fs.readdirSync(outside).length, 0);
    assert.equal(fs.lstatSync(path.join(dir, "extensions")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materialize refuses a symlink target and does not write through it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-embed-link-"));
  try {
    const dir = path.join(root, "providers", "pi", "extensions");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside.js");
    fs.writeFileSync(outside, "keep\n");
    fs.symlinkSync(outside, path.join(dir, "pi-tmux.bundle.js"));
    globalThis.__LARKIN_EMBEDDED_PI_TMUX_BUNDLE__ = "export default function() {}";
    assert.throws(() => materializeEmbeddedPiTmuxBundle(root), /Could not materialize/);
    assert.equal(fs.readFileSync(outside, "utf8"), "keep\n");
    assert.equal(fs.lstatSync(path.join(dir, "pi-tmux.bundle.js")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
