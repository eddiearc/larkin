import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateRuntimeNotices } from "../../../scripts/generate-third-party-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("runtime notices include the bundled official Pi closure", () => {
  const notice = generateRuntimeNotices();
  for (const packageName of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ]) assert.match(notice, new RegExp(packageName.replace("/", "\\/")));
  assert.match(notice, /Copyright \(c\) 2025 Mario Zechner/);
  assert.match(notice, /Permission is hereby granted, free of charge/);
  assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS"/);

  for (const relative of ["scripts/release/build.ts", "scripts/release/assemble.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /THIRD_PARTY_NOTICES\.txt/, `${relative} must redistribute the generated notice`);
    assert.match(source, /sha256File/, `${relative} must checksum the redistributed notice`);
  }
});

test("runtime notices are one locked superset across release target optional installs", () => {
  const targets = [
    new Set(["zod", "@mariozechner/clipboard", "@mariozechner/clipboard-darwin-arm64", "@mariozechner/clipboard-darwin-universal"]),
    new Set(["zod", "@mariozechner/clipboard", "@mariozechner/clipboard-darwin-x64", "@mariozechner/clipboard-darwin-universal"]),
    new Set(["zod", "@mariozechner/clipboard", "@mariozechner/clipboard-linux-arm64-gnu", "@mariozechner/clipboard-linux-arm64-musl"]),
    new Set(["zod", "@mariozechner/clipboard", "@mariozechner/clipboard-linux-x64-gnu", "@mariozechner/clipboard-linux-x64-musl"]),
    new Set(["zod", "@mariozechner/clipboard", "@mariozechner/clipboard-win32-x64-msvc"]),
  ];
  const rendered = targets.map((installedOptionalPackageNames) => generateRuntimeNotices({ installedOptionalPackageNames }));
  assert.equal(new Set(rendered).size, 1, "target-specific optional installs must yield one release notice");
  assert.equal(rendered[0], generateRuntimeNotices());
  for (const platformPackage of [
    "clipboard-darwin-arm64", "clipboard-darwin-x64", "clipboard-linux-x64-gnu", "clipboard-win32-x64-msvc",
  ]) assert.match(rendered[0], new RegExp(platformPackage));
});
