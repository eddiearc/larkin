import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const VERSION = "0.4.1";

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createCandidate(candidateRoot, markerFile, missingModule = null) {
  writeFile(path.join(candidateRoot, "package.json"), `${JSON.stringify({ name: "larkin", version: VERSION })}\n`);
  writeFile(path.join(candidateRoot, "test/fixtures/runtime-upgrade/v0.3.3-active-thread.json"), "{}\n");
  const marker = JSON.stringify(markerFile);
  const modules = {
    agentStateStore: ["dist/agent/agent-state-store.mjs", `
import fs from "node:fs";
fs.appendFileSync(${marker}, "agent-state-store\\n");
export function createAgentStateStore() {
  return { kind: "candidate-agent-state-store", origin: import.meta.url };
}
`],
    contextPrompt: ["dist/agent/context-prompt.mjs", `
import fs from "node:fs";
fs.appendFileSync(${marker}, "context-prompt\\n");
export class ContextPromptBuilder {
  constructor() {
    this.payload = { kind: "candidate-context-prompt", origin: import.meta.url };
  }
}
`],
    runtimeHost: ["dist/runtime/runtime-host.mjs", `
import fs from "node:fs";
fs.appendFileSync(${marker}, "runtime-host\\n");
export function createRuntimeHost() {
  return { kind: "candidate-runtime-host", origin: import.meta.url };
}
`],
  };
  for (const [name, [relativeFile, content]] of Object.entries(modules)) {
    if (name !== missingModule) writeFile(path.join(candidateRoot, relativeFile), content.trimStart());
  }
}

function createTopology({ missingModule = null } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-release-recovery-topology-"));
  const toolingRoot = path.join(temporaryRoot, "release-tooling");
  const candidateRoot = path.join(temporaryRoot, "release-source");
  const markerFile = path.join(temporaryRoot, "candidate-imports.txt");
  copyFile(path.join(ROOT, "scripts/release/smoke.ts"), path.join(toolingRoot, "scripts/release/smoke.ts"));
  copyFile(path.join(ROOT, "scripts/release/smoke-support.ts"), path.join(toolingRoot, "scripts/release/smoke-support.ts"));
  copyFile(path.join(ROOT, "src/platform/release-artifacts.ts"), path.join(toolingRoot, "src/platform/release-artifacts.ts"));
  createCandidate(candidateRoot, markerFile, missingModule);
  return {
    temporaryRoot,
    toolingRoot,
    toolingSmoke: path.join(toolingRoot, "scripts/release/smoke.ts"),
    candidateRoot,
    markerFile,
  };
}

function runCandidateProbe(topology, { cwd = topology.candidateRoot, candidateRoot = topology.candidateRoot } = {}) {
  const probe = path.join(topology.toolingRoot, "candidate-probe.ts");
  writeFile(probe, `
import { loadCandidateRuntimeUpgradeModules } from ${JSON.stringify(pathToFileURL(topology.toolingSmoke).href)};
const loaded = await loadCandidateRuntimeUpgradeModules(${JSON.stringify(VERSION)});
const agentStateStore = loaded.createAgentStateStore();
const contextPrompt = new loaded.ContextPromptBuilder().payload;
const runtimeHost = loaded.createRuntimeHost();
process.stdout.write(JSON.stringify({
  candidateRoot: loaded.candidateRoot,
  fixture: loaded.upgradeFixtureFile,
  origins: loaded.moduleOrigins,
  payloads: { agentStateStore, contextPrompt, runtimeHost },
}));
`.trimStart());
  return spawnSync(process.execPath, [probe], {
    cwd,
    env: { ...process.env, LARKIN_RELEASE_CANDIDATE_ROOT: candidateRoot },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
}

function moduleUrl(candidateRoot, relativeFile) {
  return pathToFileURL(fs.realpathSync.native(path.join(candidateRoot, relativeFile))).href;
}

test("recovery tooling loads the candidate-only Runtime modules and the old script-relative counterfactual fails", () => {
  const topology = createTopology();
  try {
    const oldStaticRelativeModule = path.resolve(path.dirname(topology.toolingSmoke), "../../dist/agent/agent-state-store.mjs");
    assert.equal(fs.existsSync(oldStaticRelativeModule), false, "the tooling checkout intentionally has no candidate dist");
    const counterfactual = spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(pathToFileURL(oldStaticRelativeModule).href)})`], {
      cwd: topology.candidateRoot,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    assert.notEqual(counterfactual.status, 0, "the former static script-relative import must fail in recovery topology");

    const result = runCandidateProbe(topology);
    assert.equal(result.status, 0, `candidate probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const expectedOrigins = {
      agentStateStore: moduleUrl(topology.candidateRoot, "dist/agent/agent-state-store.mjs"),
      contextPrompt: moduleUrl(topology.candidateRoot, "dist/agent/context-prompt.mjs"),
      runtimeHost: moduleUrl(topology.candidateRoot, "dist/runtime/runtime-host.mjs"),
    };
    assert.equal(payload.candidateRoot, fs.realpathSync.native(topology.candidateRoot));
    assert.equal(payload.fixture, fs.realpathSync.native(path.join(topology.candidateRoot, "test/fixtures/runtime-upgrade/v0.3.3-active-thread.json")));
    assert.deepEqual(payload.origins, expectedOrigins);
    assert.deepEqual(payload.payloads, {
      agentStateStore: { kind: "candidate-agent-state-store", origin: expectedOrigins.agentStateStore },
      contextPrompt: { kind: "candidate-context-prompt", origin: expectedOrigins.contextPrompt },
      runtimeHost: { kind: "candidate-runtime-host", origin: expectedOrigins.runtimeHost },
    });
    assert.deepEqual(fs.readFileSync(topology.markerFile, "utf8").trim().split("\n").sort(), [
      "agent-state-store",
      "context-prompt",
      "runtime-host",
    ]);
  } finally {
    fs.rmSync(topology.temporaryRoot, { recursive: true, force: true });
  }
});

test("recovery candidate authority fails closed when the explicit root is missing", () => {
  const topology = createTopology();
  try {
    const result = runCandidateProbe(topology, { candidateRoot: path.join(topology.temporaryRoot, "missing-release-source") });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LARKIN_RELEASE_CANDIDATE_ROOT candidate root is unavailable/);
    assert.equal(fs.existsSync(topology.markerFile), false, "a missing root must not import candidate code");
  } finally {
    fs.rmSync(topology.temporaryRoot, { recursive: true, force: true });
  }
});

test("recovery candidate validation rejects missing dist before importing any candidate module", () => {
  const topology = createTopology({ missingModule: "runtimeHost" });
  try {
    const result = runCandidateProbe(topology);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release smoke candidate file is missing: dist[\\/]runtime[\\/]runtime-host\.mjs/);
    assert.equal(fs.existsSync(topology.markerFile), false, "all candidate files must validate before the first dynamic import");
  } finally {
    fs.rmSync(topology.temporaryRoot, { recursive: true, force: true });
  }
});

test("recovery candidate validation rejects an explicit root that mismatches the working source", () => {
  const topology = createTopology();
  const otherCandidateRoot = path.join(topology.temporaryRoot, "other-release-source");
  const otherMarkerFile = path.join(topology.temporaryRoot, "other-candidate-imports.txt");
  createCandidate(otherCandidateRoot, otherMarkerFile);
  try {
    const result = runCandidateProbe(topology, { candidateRoot: otherCandidateRoot });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LARKIN_RELEASE_CANDIDATE_ROOT does not match the release smoke working directory/);
    assert.equal(fs.existsSync(topology.markerFile), false);
    assert.equal(fs.existsSync(otherMarkerFile), false, "a mismatched explicit root must not import either candidate");
  } finally {
    fs.rmSync(topology.temporaryRoot, { recursive: true, force: true });
  }
});
