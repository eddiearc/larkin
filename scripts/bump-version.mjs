#!/usr/bin/env bun

import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateManifestVersion } from "./versioning.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  throw new Error("用法: bun run version:bump <patch|minor|major|X.Y.Z>");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = updateManifestVersion(path.join(root, "package.json"), args[0]);
process.stdout.write(`${result.current} -> ${result.version}\n`);
