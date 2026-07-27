#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseTag } from "./versioning.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) throw new Error("用法: bun run release:check-version <vX.Y.Z>");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = assertReleaseTag(String(manifest.version || ""), args[0]);
process.stdout.write(`release version ${version} matches ${args[0]}\n`);
