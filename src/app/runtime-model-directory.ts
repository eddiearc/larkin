#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveConfigDir } from "../platform/config.js";
import { discoverClaudeModelCatalog } from "../runtime/claude-model-catalog.js";
import { discoverPiModelCatalog } from "../runtime/pi-model-catalog.js";
import { discoverCodexModelCatalog } from "../runtime/codex-model-catalog.js";
import { ownedPiCatalogAgentDir, piCatalogCommandSpec } from "../runtime/pi-provider-config.js";

type Env = Record<string, string | undefined>;

export interface RuntimeDirectoryModel {
  id: string;
  label: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface RuntimeModelDirectoryInput {
  runtime: string;
  cwd: string;
  env?: Env;
  agentId?: string;
}

function readTestModelDirectory(env: Env | undefined): RuntimeDirectoryModel[] | undefined {
  const fixture = env?.LARKIN_TEST_RUNTIME_MODEL_DIRECTORY_FILE;
  if (!fixture) return undefined;
  const parsed = JSON.parse(fs.readFileSync(fixture, "utf8")) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error("runtime model directory test fixture is invalid");
  return parsed.models as RuntimeDirectoryModel[];
}

export async function discoverRuntimeModelDirectory(input: RuntimeModelDirectoryInput): Promise<RuntimeDirectoryModel[]> {
  const testDirectory = readTestModelDirectory(input.env);
  if (testDirectory) return testDirectory;
  if (input.runtime === "codex") {
    const catalog = await discoverCodexModelCatalog({ cwd: input.cwd, env: input.env });
    return [
      { id: "default", label: `default: ${catalog.effectiveModel}` },
      ...catalog.models.map(({ id, label, supportedReasoningEfforts, defaultReasoningEffort }) => ({
        id, label, supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      })),
    ];
  }
  if (input.runtime === "claude") {
    const catalog = await discoverClaudeModelCatalog({ cwd: input.cwd, env: input.env });
    return [
      { id: "default", label: `default: ${catalog.effectiveModel}` },
      ...catalog.models.map(({ id, label, supportedReasoningEfforts }) => ({ id, label, supportedReasoningEfforts })),
    ];
  }
  if (input.runtime === "pi") {
    const env = input.env ?? process.env;
    const agentId = input.agentId || "";
    if (!agentId) throw new Error("runtime model directory requires agentId for Pi");
    const configDir = resolveConfigDir(env);
    const { config } = loadConfig(env);
    const agent = config.agents[agentId];
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    const catalogCommand = piCatalogCommandSpec(agent.piDistribution, env);
    const catalog = await discoverPiModelCatalog({
      cwd: input.cwd,
      agentDir: ownedPiCatalogAgentDir(configDir, agentId),
      command: catalogCommand.command,
      commandArgs: catalogCommand.commandArgs,
      env,
    });
    if (!catalog.effectiveModel) throw new Error("Pi 模型目录未解析出默认模型");
    return [
      { id: "default", label: `default: ${catalog.effectiveModel}` },
      ...catalog.models.map(({ id, label, supportedReasoningEfforts, defaultReasoningEffort }) => ({
        id, label, supportedReasoningEfforts, ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      })),
    ];
  }
  throw new Error(`未知 runtime：${input.runtime}`);
}

function isMainEntry(argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try { return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(argvPath) === path.resolve(fileURLToPath(import.meta.url)); }
}

export async function main(): Promise<void> {
  const runtime = process.argv[2] || "";
  const cwd = process.argv[3] || "";
  const agentId = process.argv[4] || "";
  if (!runtime || !cwd) throw new Error("runtime model directory requires runtime and cwd");
  const models = await discoverRuntimeModelDirectory({
    runtime,
    cwd,
    env: process.env,
    ...(agentId ? { agentId } : {}),
  });
  process.stdout.write(`${JSON.stringify({ models })}\n`);
}

if (isMainEntry()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
