import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_TARGETS = Object.freeze([
  { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
  { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64-baseline" },
  { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64-baseline" },
] as const);

export type ReleasePlatform = typeof RELEASE_TARGETS[number]["platform"];
export type ReleaseArch = typeof RELEASE_TARGETS[number]["arch"];

export interface ReleaseArtifactRecord {
  platform: ReleasePlatform;
  arch: ReleaseArch;
  file: string;
  sha256: string;
  size: number;
  signing: "adhoc" | "unsigned";
}

export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  sourceDirty: boolean;
  bunVersion: string;
  bytecode: false;
  notices: ReleaseNoticeRecord;
  artifacts: ReleaseArtifactRecord[];
}

export interface ReleaseNoticeRecord {
  file: "THIRD_PARTY_NOTICES.txt";
  sha256: string;
  size: number;
  scope: "runtime-closure";
}

export function artifactFilename(version: string, platform: ReleasePlatform, arch: ReleaseArch): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid release version: ${version}`);
  if (!RELEASE_TARGETS.some((target) => target.platform === platform && target.arch === arch)) {
    throw new Error(`unsupported release target: ${platform}-${arch}`);
  }
  return `larkin-v${version}-${platform}-${arch}`;
}

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function selectReleaseArtifact(
  manifest: ReleaseManifest,
  platform: string,
  arch: string,
): ReleaseArtifactRecord {
  const record = manifest.artifacts.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!record || !RELEASE_TARGETS.some((target) => target.platform === platform && target.arch === arch)) {
    throw new Error(`unsupported platform: ${platform}-${arch}`);
  }
  if (record.file !== artifactFilename(manifest.version, record.platform, record.arch) || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`invalid artifact manifest entry: ${record.file}`);
  }
  return record;
}

export function verifyReleaseArtifact(directory: string, record: ReleaseArtifactRecord): string {
  const root = path.resolve(directory);
  const file = path.resolve(root, record.file);
  if (path.dirname(file) !== root) throw new Error("artifact path escaped release directory");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !Number.isSafeInteger(record.size) || record.size <= 0 || stat.size !== record.size) {
    throw new Error(`invalid artifact size for ${record.file}`);
  }
  const actual = sha256File(file);
  if (actual !== record.sha256) throw new Error(`checksum mismatch for ${record.file}`);
  return file;
}

export function verifyReleaseNotices(directory: string, manifest: ReleaseManifest): string {
  const record = manifest.notices;
  if (!record || record.file !== "THIRD_PARTY_NOTICES.txt" || record.scope !== "runtime-closure" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error("invalid runtime notices manifest entry");
  }
  const root = path.resolve(directory);
  const file = path.resolve(root, record.file);
  if (path.dirname(file) !== root) throw new Error("runtime notices path escaped release directory");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !Number.isSafeInteger(record.size) || record.size <= 0 || stat.size !== record.size) {
    throw new Error("invalid runtime notices size");
  }
  if (sha256File(file) !== record.sha256) throw new Error("runtime notices checksum mismatch");
  return file;
}
