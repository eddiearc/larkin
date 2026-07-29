#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostShell } from "../feishu/host-shell.js";
import { ContextPromptBuilder } from "../agent/context-prompt.js";
import { createNativeRuntimeAdapter } from "../runtime/runtime-adapters.js";
import { createRuntimeHost, type RuntimeHost } from "../runtime/runtime-host.js";
import { createAgentStateStore } from "../agent/agent-state-store.js";
import { loadConfig, markConfigApplied, runtimeConfigSignature } from "../platform/config.js";
import { createAgentControlServer } from "./local-control.js";
import { hydrateRuntimeAgent, syncAgentProfile, type RuntimeAgentConfigDependencies } from "./runtime-agent-config.js";
import { assertRuntimeCliBindingReady } from "./runtime-cli-binding.js";

type HostShellOptions = Parameters<typeof createHostShell>[0];

export function loadAndSyncRuntimeAgent(env: NodeJS.ProcessEnv, agentId: string, dependencies: RuntimeAgentConfigDependencies = {}) {
  const loaded = loadConfig(env);
  const stored = loaded.config.agents[agentId];
  if (!stored) throw new Error(`Agent ${agentId} 不存在于 canonical config`);
  const agent = hydrateRuntimeAgent(loaded.configDir, stored);
  syncAgentProfile(agent, { ...env, LARKIN_CONFIG_DIR: loaded.configDir }, dependencies);
  return agent;
}

export async function markConfigAppliedAfterRuntimeReady(
  env: NodeJS.ProcessEnv,
  runningAgents: ReadonlyArray<{ agentId: string; runtime: string; model: string; effort?: string | null }>,
  runtimeReady: Promise<void>,
): Promise<void> {
  await runtimeReady;
  try {
    const loaded = loadConfig(env);
    for (const running of runningAgents) {
      const current = loaded.config.agents[running.agentId];
      if (!current || current.runtime !== running.runtime || current.model !== running.model || (current.effort || null) !== (running.effort || null)) continue;
      markConfigApplied(env, running.agentId, runtimeConfigSignature(loaded.config, running.agentId));
    }
  } catch { /* Runtime is ready; apply projection stays pending on a concurrent config change. */ }
}

export async function main(env: NodeJS.ProcessEnv = process.env, overrides: {
  runtimeHost?: RuntimeHost;
  channelPackage?: HostShellOptions["channelPackage"];
  eventSourceStartDelayMs?: number;
  channelDisconnectTimeoutMs?: number;
  exitProcess?: (exitCode: number) => void;
} = {}): Promise<void> {
  let channelPackage = overrides.channelPackage;
  if (!channelPackage && env.LARKIN_FEISHU_DRYRUN === "1" && env.LARKIN_TEST_CHANNEL_MODULE) {
    channelPackage = await import(pathToFileURL(path.resolve(env.LARKIN_TEST_CHANNEL_MODULE)).href) as HostShellOptions["channelPackage"];
  }
  const adapters = new Map<string, ReturnType<typeof createNativeRuntimeAdapter>>();
  const runtimeHost = overrides.runtimeHost ?? createRuntimeHost({
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor(agentId) {
      if (!env.LARKIN_HOME) throw new Error("LARKIN_HOME is required for Runtime delivery state");
      return createAgentStateStore(env.LARKIN_HOME, agentId);
    },
    adapterFor(runtime) {
      let adapter = adapters.get(runtime);
      if (!adapter) {
        adapter = createNativeRuntimeAdapter(runtime, { env,
          ...(runtime === "codex" && env.LARKIN_CODEX_COMMAND ? { codexCommand: env.LARKIN_CODEX_COMMAND } : {}),
          ...(runtime === "codex" && env.LARKIN_CODEX_MODEL ? { codexModelOverride: env.LARKIN_CODEX_MODEL } : {}) });
        adapters.set(runtime, adapter);
      }
      return adapter;
    },
    assertRuntimeCliReady(agent) {
      assertRuntimeCliBindingReady(agent.runtimeCliBinding, { ...env, LARKIN_CONFIG_DIR: env.LARKIN_CONFIG_DIR });
    },
    log: (...parts) => process.stderr.write(`[runtime] ${parts.join(" ")}\n`),
  });
  let controlServer: ReturnType<typeof createAgentControlServer> | null = null;
  const hostShell = createHostShell({
    env,
    runtimeHost,
    ...(channelPackage ? { channelPackage } : {}),
    ...(overrides.eventSourceStartDelayMs !== undefined ? { eventSourceStartDelayMs: overrides.eventSourceStartDelayMs } : {}),
    ...(overrides.channelDisconnectTimeoutMs !== undefined ? { channelDisconnectTimeoutMs: overrides.channelDisconnectTimeoutMs } : {}),
    onOrderedShutdownComplete: (exitCode) => {
      void controlServer?.close().catch(() => {}).finally(() => {
        (overrides.exitProcess ?? ((code) => process.exit(code)))(exitCode);
      });
    },
  });
  if (!env.LARKIN_HOME || !env.LARKIN_CONFIG_DIR) throw new Error("LARKIN_HOME/LARKIN_CONFIG_DIR required");
  if (!env.LARKIN_CONTROL_AUTHORIZATION) throw new Error("LARKIN_CONTROL_AUTHORIZATION required");
  controlServer = createAgentControlServer({
    larkinHome: env.LARKIN_HOME,
    authorityToken: env.LARKIN_CONTROL_AUTHORIZATION,
    async upsert(request) {
      const agent = loadAndSyncRuntimeAgent(env, request.agentId);
      // Only the selected profile is synchronized; active profiles and their directory
      // are never quarantined or rebuilt during hot attach.
      await hostShell.upsertAgent(agent);
    },
  });
  await controlServer.start();
  await markConfigAppliedAfterRuntimeReady(env, hostShell.agents, hostShell.start());
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
