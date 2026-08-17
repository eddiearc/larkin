import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exactMode } from "../platform/secure-metadata.js";

export const PI_RUNTIME_ARTIFACT_MANIFEST = ".larkin-pi-owned-artifacts.json";
export const PI_RUNTIME_ARTIFACT_NAMES = [".larkin-official-pi-package", "models-store.json", "npm"] as const;
type ArtifactName = typeof PI_RUNTIME_ARTIFACT_NAMES[number];
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 4096;

export interface PiArtifactIdentity {
  kind: "file" | "directory";
  mode: number;
  device: string;
  inode: string;
  bytes: number;
  digest: string;
}

export interface PiArtifactManifest {
  version: 1;
  owner: "larkin-builtin-pi";
  directory: { device: string; inode: string };
  recordedAt: string;
  artifacts: Partial<Record<ArtifactName, PiArtifactIdentity>>;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSafeEntry(file: string, label: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner is unsafe`);
  return stat;
}

function identity(file: string, label: string): PiArtifactIdentity {
  const stat = assertSafeEntry(file, label);
  const mode = stat.mode & 0o777;
  if (stat.isFile()) {
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${label} is too large`);
    const bytes = fs.readFileSync(file);
    return { kind: "file", mode, device: String(stat.dev), inode: String(stat.ino), bytes: bytes.length, digest: digest(bytes) };
  }
  if (!stat.isDirectory()) throw new Error(`${label} has an unsupported type`);
  const entries = fs.readdirSync(file).sort();
  if (entries.length > MAX_ENTRIES) throw new Error(`${label} has too many entries`);
  const children = entries.map((name) => {
    if (name === "." || name === ".." || name.includes("/")) throw new Error(`${label} contains an unsafe entry`);
    const child = identity(path.join(file, name), `${label} child`);
    return [name, child.kind, child.mode, child.device, child.inode, child.bytes, child.digest];
  });
  return {
    kind: "directory", mode, device: String(stat.dev), inode: String(stat.ino),
    bytes: children.reduce((sum, child) => sum + Number(child[5]), 0), digest: digest(JSON.stringify(children)),
  };
}

function sameIdentity(actual: PiArtifactIdentity, expected: PiArtifactIdentity): boolean {
  return actual.kind === expected.kind && actual.mode === expected.mode
    && actual.device === expected.device && actual.inode === expected.inode
    && actual.bytes === expected.bytes && actual.digest === expected.digest;
}

function readManifest(file: string): PiArtifactManifest | null {
  try {
    const stat = assertSafeEntry(file, "Pi artifact provenance manifest");
    if (!stat.isFile() || !exactMode(stat, 0o600) || stat.size > 1024 * 1024) throw new Error("Pi artifact provenance manifest is unsafe");
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as PiArtifactManifest;
    if (value?.version !== 1 || value.owner !== "larkin-builtin-pi" || !value.directory || !value.artifacts) throw new Error("Pi artifact provenance manifest is invalid");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeManifest(file: string, value: PiArtifactManifest): void {
  const temp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

/** Record only allowed entries that were absent at the runtime spawn boundary. */
export function recordPiRuntimeArtifactProvenance(targetDir: string, beforeEntries: ReadonlySet<string>, boundaryAt = Date.now()): void {
  const target = assertSafeEntry(targetDir, "Pi provider target");
  if (!target.isDirectory() || !exactMode(target, 0o700)) throw new Error("Pi provider target is unsafe");
  const manifestFile = path.join(targetDir, PI_RUNTIME_ARTIFACT_MANIFEST);
  const existing = readManifest(manifestFile);
  const manifest: PiArtifactManifest = existing ?? {
    version: 1, owner: "larkin-builtin-pi", directory: { device: String(target.dev), inode: String(target.ino) },
    recordedAt: new Date(boundaryAt).toISOString(), artifacts: {},
  };
  if (manifest.directory.device !== String(target.dev) || manifest.directory.inode !== String(target.ino)) throw new Error("Pi artifact provenance target identity changed");
  let changed = false;
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    if (!PI_RUNTIME_ARTIFACT_NAMES.includes(name as ArtifactName) || name.includes("/") || !expected) throw new Error("Pi artifact provenance entry is invalid");
    const actual = identity(path.join(targetDir, name), `Pi artifact ${name}`);
    const sameOwner = actual.kind === expected.kind && actual.mode === expected.mode
      && actual.device === expected.device && actual.inode === expected.inode;
    if (!sameOwner) throw new Error(`Pi artifact ${name} provenance identity changed`);
    if (!sameIdentity(actual, expected)) { manifest.artifacts[name as ArtifactName] = actual; changed = true; }
  }
  for (const name of PI_RUNTIME_ARTIFACT_NAMES) {
    if (beforeEntries.has(name) || manifest.artifacts[name]) continue;
    const file = path.join(targetDir, name);
    if (!fs.existsSync(file)) continue;
    const actual = identity(file, `Pi artifact ${name}`);
    const stat = fs.lstatSync(file);
    if (stat.birthtimeMs + 1 < boundaryAt && stat.mtimeMs + 1 < boundaryAt) throw new Error(`Pi artifact ${name} predates runtime provenance boundary`);
    manifest.artifacts[name] = actual;
    changed = true;
  }
  if (changed) writeManifest(manifestFile, manifest);
}

/** Return the names that are both explicitly attested and unchanged. */
export function attestedPiRuntimeArtifactNames(targetDir: string): ReadonlySet<string> {
  const target = assertSafeEntry(targetDir, "Pi provider target");
  if (!target.isDirectory()) throw new Error("Pi provider target is unsafe");
  const manifest = readManifest(path.join(targetDir, PI_RUNTIME_ARTIFACT_MANIFEST));
  if (!manifest || manifest.directory.device !== String(target.dev) || manifest.directory.inode !== String(target.ino)) return new Set();
  const names = new Set<string>();
  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    if (!PI_RUNTIME_ARTIFACT_NAMES.includes(name as ArtifactName) || !expected) continue;
    const actual = identity(path.join(targetDir, name), `Pi artifact ${name}`);
    if (!sameIdentity(actual, expected)) throw new Error(`Pi artifact ${name} provenance changed`);
    names.add(name);
  }
  return names;
}
