#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const directory of ["dist", "artifacts"]) {
  fs.rmSync(path.join(ROOT, directory), { recursive: true, force: true });
}
