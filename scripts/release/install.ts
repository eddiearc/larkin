#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  selectReleaseArtifact,
  verifyReleaseArtifact,
  verifyReleaseNotices,
  type ReleaseManifest,
} from "../../src/platform/release-artifacts.js";

const args = process.argv.slice(2);
const has = (name: string): boolean => args.includes(name);
const value = (name: string, fallback = ""): string => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const installDirInput = value("--install-dir");
if (!installDirInput) throw new Error("--install-dir is required");
const installDir = path.resolve(installDirInput);
const osPlatform = value("--platform", os.platform());
const windows = osPlatform === "win32" || osPlatform === "windows";
const destination = path.join(installDir, windows ? "larkin.exe" : "larkin");
const previous = path.join(installDir, windows ? "larkin.previous.exe" : "larkin.previous");

fs.mkdirSync(installDir, { recursive: true, mode: 0o755 });
if (has("--rollback")) {
  if (!fs.existsSync(previous)) throw new Error("no previous Larkin artifact is available for rollback");
  const displaced = path.join(installDir, `.larkin.${process.pid}.rollback`);
  if (fs.existsSync(destination)) fs.renameSync(destination, displaced);
  try {
    fs.renameSync(previous, destination);
    if (fs.existsSync(displaced)) fs.renameSync(displaced, previous);
  } catch (error) {
    if (!fs.existsSync(destination) && fs.existsSync(displaced)) fs.renameSync(displaced, destination);
    throw error;
  }
  process.stdout.write(`rolled back ${destination}\n`);
  process.exit(0);
}

const releaseDirInput = value("--release-dir");
if (!releaseDirInput) throw new Error("--release-dir is required");
const releaseDir = path.resolve(releaseDirInput);
const manifestFile = path.join(releaseDir, "release-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as ReleaseManifest;
verifyReleaseNotices(releaseDir, manifest);
if (manifest.sourceDirty && !has("--allow-dirty")) throw new Error("refusing an artifact built from a dirty source tree");
const platform = osPlatform;
const arch = value("--arch", os.arch());
const record = selectReleaseArtifact(manifest, platform, arch);
const artifact = verifyReleaseArtifact(releaseDir, record);
const staged = path.join(installDir, `.larkin.${process.pid}.next`);
try {
  fs.copyFileSync(artifact, staged, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(staged, 0o755);
  if (verifyReleaseArtifact(installDir, { ...record, file: path.basename(staged) }) !== staged) throw new Error("staged artifact verification failed");
  if (record.platform === "darwin" && record.signing !== "unsigned" && Bun.which("codesign")) {
    const signature = Bun.spawnSync(["codesign", "--verify", "--verbose=2", staged], { stdout: "pipe", stderr: "pipe" });
    if (signature.exitCode !== 0) throw new Error(`signature verification failed for ${record.file}`);
  }
} catch (error) {
  try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch { /* best effort */ }
  throw error;
}

let movedCurrent = false;
const displacedPrevious = path.join(installDir, `.larkin.${process.pid}.previous`);
try {
  if (fs.existsSync(previous)) fs.renameSync(previous, displacedPrevious);
  if (fs.existsSync(destination)) { fs.renameSync(destination, previous); movedCurrent = true; }
  fs.renameSync(staged, destination);
  if (fs.existsSync(displacedPrevious)) fs.unlinkSync(displacedPrevious);
} catch (error) {
  try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch { /* best effort */ }
  if (movedCurrent && !fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
  if (!fs.existsSync(previous) && fs.existsSync(displacedPrevious)) fs.renameSync(displacedPrevious, previous);
  throw error;
}
process.stdout.write(`installed ${record.file} at ${destination}; checksum verified\n`);
