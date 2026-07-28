#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import {
  RELEASE_TARGETS,
  sha256File,
  verifyReleaseArtifact,
  verifyReleaseNotices,
  type ReleaseArtifactRecord,
  type ReleaseManifest,
} from "../../src/platform/release-artifacts.js";
import { generateRuntimeNotices } from "../generate-third-party-notices.mjs";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function findManifests(root: string): string[] {
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /^release-manifest(?:-[^.]+)?\.json$/.test(entry.name)) matches.push(absolute);
    }
  };
  visit(root);
  return matches.sort();
}

export function assembleRelease(inputDirectory: string, outputDirectory: string): ReleaseManifest {
  const manifests = findManifests(inputDirectory).map((file) => ({
    directory: path.dirname(file),
    manifest: JSON.parse(fs.readFileSync(file, "utf8")) as ReleaseManifest,
  }));
  if (manifests.length !== RELEASE_TARGETS.length) {
    throw new Error(`expected ${RELEASE_TARGETS.length} platform manifests, found ${manifests.length}`);
  }

  const first = manifests[0].manifest;
  if (first.schemaVersion !== 1 || first.sourceDirty || first.bytecode !== false) {
    throw new Error("invalid release provenance in first platform manifest");
  }
  const records = new Map<string, { directory: string; record: ReleaseArtifactRecord }>();
  for (const candidate of manifests) {
    const manifest = candidate.manifest;
    if (
      manifest.schemaVersion !== first.schemaVersion || manifest.version !== first.version ||
      manifest.sourceCommit !== first.sourceCommit || manifest.sourceDirty ||
      manifest.bunVersion !== first.bunVersion || manifest.bytecode !== first.bytecode ||
      manifest.artifacts.length !== 1
    ) {
      throw new Error(`platform manifest does not match release provenance: ${candidate.directory}`);
    }
    const record = manifest.artifacts[0];
    verifyReleaseArtifact(candidate.directory, record);
    const key = `${record.platform}-${record.arch}`;
    if (records.has(key)) throw new Error(`duplicate release target: ${key}`);
    records.set(key, { directory: candidate.directory, record });
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const artifacts = RELEASE_TARGETS.map((target) => {
    const key = `${target.platform}-${target.arch}`;
    const selected = records.get(key);
    if (!selected) throw new Error(`missing release target: ${key}`);
    const source = path.join(selected.directory, selected.record.file);
    const destination = path.join(outputDirectory, selected.record.file);
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, 0o755);
    if (sha256File(destination) !== selected.record.sha256) throw new Error(`copy checksum mismatch: ${selected.record.file}`);
    return selected.record;
  });

  const repositoryRoot = path.resolve(import.meta.dirname, "..", "..");
  fs.copyFileSync(path.join(repositoryRoot, "LICENSE"), path.join(outputDirectory, "LICENSE"));
  const noticesFile = path.join(outputDirectory, "THIRD_PARTY_NOTICES.txt");
  fs.writeFileSync(noticesFile, generateRuntimeNotices());
  const notices = {
    file: "THIRD_PARTY_NOTICES.txt" as const,
    sha256: sha256File(noticesFile),
    size: fs.statSync(noticesFile).size,
    scope: "runtime-closure" as const,
  };
  for (const candidate of manifests) {
    if (JSON.stringify(candidate.manifest.notices) !== JSON.stringify(notices)) {
      throw new Error(`platform manifest runtime notices do not match release output: ${candidate.directory}`);
    }
  }
  const combined: ReleaseManifest = { ...first, notices, artifacts };
  fs.writeFileSync(path.join(outputDirectory, "release-manifest.json"), `${JSON.stringify(combined, null, 2)}\n`);
  verifyReleaseNotices(outputDirectory, combined);
  fs.writeFileSync(
    path.join(outputDirectory, "SHA256SUMS"),
    `${[
      ...artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`),
      `${notices.sha256}  ${notices.file}`,
    ].join("\n")}\n`,
  );
  return combined;
}

if (import.meta.main) {
  const inputDirectory = path.resolve(argument("--input-dir", "artifacts/platform"));
  const outputDirectory = path.resolve(argument("--out-dir", "artifacts/release"));
  process.stdout.write(`${JSON.stringify(assembleRelease(inputDirectory, outputDirectory), null, 2)}\n`);
}
