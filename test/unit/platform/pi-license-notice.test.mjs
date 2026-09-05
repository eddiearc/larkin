import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generateRuntimeNotices } from "../../../scripts/generate-third-party-notices.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

test("runtime notices exclude the host Pi package and still ship the redistributed notice", () => {
  const notice = generateRuntimeNotices();
  assert.doesNotMatch(notice, /@earendil-works\/pi-coding-agent/);
  assert.doesNotMatch(notice, /@earendil-works\/pi-agent-core/);
  assert.match(notice, /@tintinweb\/pi-subagents/);
  assert.match(notice, /Permission is hereby granted, free of charge|Apache License/);

  for (const relative of ["scripts/release/build.ts", "scripts/release/assemble.ts"]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /THIRD_PARTY_NOTICES\.txt/, `${relative} must redistribute the generated notice`);
    assert.match(source, /sha256File/, `${relative} must checksum the redistributed notice`);
  }
});

test("runtime notices are deterministic across optional-install views", () => {
  const rendered = [
    generateRuntimeNotices(),
    generateRuntimeNotices({ installedOptionalPackageNames: new Set() }),
    generateRuntimeNotices({ installedOptionalPackageNames: new Set(["zod"]) }),
  ];
  assert.equal(new Set(rendered).size, 1, "optional-install views must yield one release notice");
});
