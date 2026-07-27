import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("dashboard asset registry prefers compiled bytes and keeps a source-tree fallback", async () => {
  const { dashboardAsset } = await import(path.join(ROOT, "dist/dashboard/dashboard-assets.mjs"));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-assets-"));
  try {
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(directory, "assets/larkin-mark.svg"), "disk-svg");
    delete globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__;
    const disk = dashboardAsset("larkin-mark.svg", directory);
    assert.equal(Buffer.from(disk.body).toString(), "disk-svg");
    assert.equal(disk.embedded, false);
    globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__ = {
      "larkin-mark.svg": new TextEncoder().encode("embedded-svg"),
      "dashboard.css": new TextEncoder().encode("embedded-css"),
      "dashboard.js": new TextEncoder().encode("embedded-js"),
    };
    const embedded = dashboardAsset("dashboard.js", "/does/not/exist");
    assert.equal(Buffer.from(embedded.body).toString(), "embedded-js");
    assert.equal(embedded.embedded, true);
  } finally {
    delete globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
