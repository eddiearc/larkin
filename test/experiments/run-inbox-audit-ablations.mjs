#!/usr/bin/env bun
/* Rebuild and run manifest-listed source ablations in disposable worktrees. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "inbox-audit-ablation.mjs");

function usage() {
  return [
    "Usage:",
    "  bun test/experiments/run-inbox-audit-ablations.mjs --patch-root <dir> --source <base-sha>=<repo> [--source <base-sha>=<repo> ...] [--output-dir <dir>] [--run|--sidecar-only]",
    "",
    "Without --run or --sidecar-only, prints the manifest plan without creating worktrees or running commands.",
  ].join("\n");
}

function parseAssignment(value, flag) {
  const separator = String(value || "").indexOf("=");
  if (separator < 1 || separator === String(value).length - 1) throw new Error(`${flag} requires key=value`);
  return [String(value).slice(0, separator), path.resolve(String(value).slice(separator + 1))];
}

function parseArgs(argv) {
  let patchRoot = path.join(HERE, "inbox-audit-ablation-patches");
  let outputDir = path.join(os.tmpdir(), "larkin-inbox-audit-ablations-rerun");
  let run = false;
  let sidecarOnly = false;
  const sources = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--patch-root") patchRoot = path.resolve(argv[++index] || "");
    else if (flag === "--source") {
      const [sha, repo] = parseAssignment(argv[++index], flag);
      sources.set(sha, repo);
    } else if (flag === "--output-dir") outputDir = path.resolve(argv[++index] || outputDir);
    else if (flag === "--run") run = true;
    else if (flag === "--sidecar-only") sidecarOnly = true;
    else if (flag === "--help") { console.log(usage()); process.exit(0); }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (sources.size === 0) throw new Error(usage());
  if (run && sidecarOnly) throw new Error("--run and --sidecar-only cannot be combined");
  return { patchRoot, outputDir, run, sidecarOnly, sources };
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${[command, ...args].join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown failure").slice(-800)}`);
  return result;
}

function isolatedEnv(home) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    LARKIN_HOME: home,
    LARKIN_CONFIG_DIR: home,
    LARKSUITE_CLI_CONFIG_DIR: path.join(home, "lark-cli-config"),
    NO_COLOR: "1",
  };
}

function patchLabel(filename) { return filename.replace(/\.patch$/, ""); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

const options = parseArgs(process.argv.slice(2));
const manifestPath = path.join(options.patchRoot, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const manifestSha256 = sha256(fs.readFileSync(manifestPath));
if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) throw new Error("manifest variants must be a nonempty array");
const plan = manifest.variants.map((entry) => {
  const source = options.sources.get(entry.baseSHA);
  if (!source) throw new Error(`missing --source for baseSHA ${entry.baseSHA}`);
  const patch = path.join(options.patchRoot, entry.patch);
  if (!fs.existsSync(patch)) throw new Error(`missing patch: ${patch}`);
  return { label: patchLabel(entry.patch), baseSHA: entry.baseSHA, source, patch };
});

if (!options.run && !options.sidecarOnly) {
  console.log(JSON.stringify({ mode: "dry-run", runner: path.relative(process.cwd(), RUNNER), outputDir: options.outputDir, plan }, null, 2));
  process.exit(0);
}

fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-ablation-driver-"));
const results = [];
try {
  for (const item of plan) {
    const worktree = path.join(scratch, item.label);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-ablation-install-home-"));
    const output = path.join(options.outputDir, `${item.label}.json`);
    try {
      command("git", ["-C", item.source, "worktree", "add", "--detach", worktree, item.baseSHA]);
      command("git", ["-C", worktree, "apply", "--check", item.patch]);
      command("git", ["-C", worktree, "apply", item.patch]);
      const appliedDiff = execFileSync("git", ["-C", worktree, "diff", "--no-ext-diff"], { encoding: "utf8" });
      const changedFiles = execFileSync("git", ["-C", worktree, "diff", "--name-only"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      if (options.run) {
        command("bun", ["install", "--frozen-lockfile"], { cwd: worktree, env: isolatedEnv(home) });
        command("bun", [RUNNER, "--build", "--root", `${item.label}=${worktree}`, "--output", output], {
          cwd: path.resolve(HERE, "../.."), env: isolatedEnv(home),
        });
      }
      const runnerResult = JSON.parse(fs.readFileSync(output, "utf8"));
      const provenance = {
        schema: "larkin.inbox-audit-ablation.provenance.v1",
        manifest: { file: path.basename(manifestPath), sha256: manifestSha256 },
        patch: { file: path.basename(item.patch), sha256: sha256(fs.readFileSync(item.patch)), baseSHA: item.baseSHA },
        source: { appliedDiffSha256: sha256(appliedDiff), changedFiles, dirtyState: "single_patch_applied" },
        runner: { file: path.basename(RUNNER), sha256: runnerResult.runner?.digest ?? null },
        result: { file: path.basename(output), validity: runnerResult.variants?.find((variant) => variant.name === item.label)?.validity ?? null },
      };
      const sidecar = `${output}.provenance.json`;
      fs.writeFileSync(sidecar, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
      results.push({ label: item.label, baseSHA: item.baseSHA, output, sidecar });
    } finally {
      try { execFileSync("git", ["-C", item.source, "worktree", "remove", "--force", worktree], { stdio: "ignore" }); } catch { /* cleanup best effort */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ mode: options.run ? "run" : "sidecar-only", outputDir: options.outputDir, results }, null, 2));
