#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_TARGETS,
  artifactFilename,
  sha256File,
  type ReleaseArtifactRecord,
  type ReleaseManifest,
} from "../../src/platform/release-artifacts.js";
import { generateRuntimeNotices } from "../generate-third-party-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args[index + 1];
};
const outDir = path.resolve(value("--out-dir", path.join(ROOT, "artifacts", "release")));
const onlyTarget = value("--target", "all");
const allowDirty = args.includes("--allow-dirty");
const allowUnsignedMacos = args.includes("--allow-unsigned-macos");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version?: string };
const packageVersion = String(packageJson.version || "");
const testVersion = value("--test-version", "");
if (testVersion && (!allowDirty || process.env.LARKIN_RELEASE_TEST_VERSION_OVERRIDE !== "1")) {
  throw new Error("--test-version requires --allow-dirty and LARKIN_RELEASE_TEST_VERSION_OVERRIDE=1");
}
if (testVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(testVersion)) {
  throw new Error("--test-version must be a valid release version");
}
const version = testVersion || packageVersion;
const required = [
  "dist/app/binary-entry.mjs",
  "dist/dashboard/web/assets/dashboard.css",
  "dist/dashboard/web/assets/dashboard.js",
  "assets/larkin-mark.svg",
];
for (const relative of required) {
  if (!fs.existsSync(path.join(ROOT, relative))) throw new Error(`release input missing: ${relative}; run the production build first`);
}

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function runtimeFingerprint(): string {
  const hash = crypto.createHash("sha256");
  const roots = [path.join(ROOT, "dist"), path.join(ROOT, "assets")];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  roots.forEach(visit);
  for (const file of files) {
    hash.update(path.relative(ROOT, file)); hash.update("\0"); hash.update(fs.readFileSync(file)); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

const selected = RELEASE_TARGETS.filter((target) => onlyTarget === "all" || `${target.platform}-${target.arch}` === onlyTarget);
if (!selected.length) throw new Error(`unsupported --target ${onlyTarget}`);
const sourceCommit = commandOutput(["git", "rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("git returned an invalid source commit");
const sourceDirty = commandOutput(["git", "status", "--porcelain", "--untracked-files=normal"]).length > 0;
if (sourceDirty && !allowDirty) throw new Error("release build requires a clean source tree; use --allow-dirty only for local validation");
const fingerprint = runtimeFingerprint();
fs.mkdirSync(outDir, { recursive: true });
const artifacts: ReleaseArtifactRecord[] = [];

for (const target of selected) {
  const file = artifactFilename(version, target.platform, target.arch);
  const output = path.join(outDir, file);
  const build = Bun.spawnSync([
    process.execPath,
    "build",
    path.join(ROOT, "scripts/release/standalone-entry.ts"),
      "--compile",
      "--minify",
      `--target=${target.bunTarget}`,
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      `--define=LARKIN_WRAPPED_ENTRY=true`,
      `--define=LARKIN_BUILD_VERSION=${JSON.stringify(version)}`,
      `--define=LARKIN_BUILD_FINGERPRINT=${JSON.stringify(fingerprint)}`,
    `--outfile=${output}`,
  ], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (build.exitCode !== 0) throw new Error(`Bun compile failed for ${target.platform}-${target.arch}`);
  fs.chmodSync(output, 0o755);
  let signing: ReleaseArtifactRecord["signing"] = "unsigned";
  if (target.platform === "darwin" && process.platform === "darwin" && Bun.which("codesign")) {
    const signed = Bun.spawnSync(["codesign", "--force", "--sign", "-", output], { stdout: "inherit", stderr: "inherit" });
    const verified = signed.exitCode === 0
      ? Bun.spawnSync(["codesign", "--verify", "--verbose=2", output], { stdout: "inherit", stderr: "inherit" })
      : signed;
    if (signed.exitCode !== 0 || verified.exitCode !== 0) throw new Error(`ad-hoc codesign failed for ${file}`);
    signing = "adhoc";
  }
  if (target.platform === "darwin" && signing === "unsigned" && !allowUnsignedMacos) {
    throw new Error(`macOS signing is unavailable for ${file}; build on macOS or explicitly use --allow-unsigned-macos for a non-release validation`);
  }
  artifacts.push({
    platform: target.platform,
    arch: target.arch,
    file,
    sha256: sha256File(output),
    size: fs.statSync(output).size,
    signing,
  });
}

const noticesFile = path.join(outDir, "THIRD_PARTY_NOTICES.txt");
fs.writeFileSync(noticesFile, generateRuntimeNotices());
const notices = {
  file: "THIRD_PARTY_NOTICES.txt" as const,
  sha256: sha256File(noticesFile),
  size: fs.statSync(noticesFile).size,
  scope: "runtime-closure" as const,
};
const manifest: ReleaseManifest = {
  schemaVersion: 1,
  version,
  sourceCommit,
  sourceDirty,
  bunVersion: Bun.version,
  bytecode: false,
  notices,
  artifacts,
};
fs.writeFileSync(path.join(outDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${[
  ...artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`),
  `${notices.sha256}  ${notices.file}`,
].join("\n")}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
