import { pathToFileURL } from "node:url";
import type { ExtensionAPI, InlineExtension, MainOptions } from "@earendil-works/pi-coding-agent";
import bashTimeoutExtension from "./pi-bash-timeout-extension.js";
import { bundledPiSubagentExtensionPath } from "./pi-subagent-injection.js";
import piSubagentRecordWatchdog from "./pi-subagent-record-watchdog.js";

/**
 * Load the prebuilt, patched subagent bundle shipped in dist/ rather than the
 * package-manager copy. Standalone binaries additionally load the patched
 * package through Bun's compiled module graph, while normal package installs
 * continue to use the prebuilt patched bundle.
 */
async function loadBundledPiSubagentExtension(): Promise<InlineExtension> {
  const bundle = bundledPiSubagentExtensionPath(process.env.LARKIN_CONFIG_DIR);
  if (!bundle) throw new Error("Larkin bounded pi-subagents bundle is unavailable; refusing to start builtin Pi");
  const loaded = await import(pathToFileURL(bundle).href) as { default?: InlineExtension };
  if (!loaded.default) throw new Error("Larkin bounded pi-subagents bundle is invalid; refusing to start builtin Pi");
  return loaded.default;
}

function asFactory(mod: unknown, name: string): { name: string; factory: (pi: ExtensionAPI) => void | Promise<void> } {
  const factory = typeof mod === "function"
    ? mod as (pi: ExtensionAPI) => void | Promise<void>
    : mod && typeof (mod as { default?: unknown }).default === "function"
      ? (mod as { default: (pi: ExtensionAPI) => void | Promise<void> }).default
      : undefined;
  if (!factory) throw new Error(`${name} extension factory is missing`);
  return {
    name,
    factory: async (pi) => {
      try {
        await factory(pi);
      } catch (error) {
        throw error instanceof Error ? error : new Error(`${name}: ${String(error)}`);
      }
    },
  };
}

/** Builtin Pi extensions are loaded as code, never through Pi's path/data-URL loader. */
const bundledSubagentsExtension = {
  name: "larkin-pi-subagents",
  factory: async (pi: ExtensionAPI) => {
    const extension = await loadBundledPiSubagentExtension();
    if (typeof extension === "function") await extension(pi);
    else await extension.factory(pi);
  },
};

// Watchdog must register session_shutdown before the bundled subagent extension
// so the final sweep can still read AgentManager.getRecord and bridge consumed
// terminals before manager teardown.
export const BUILTIN_PI_EXTENSION_FACTORIES: readonly InlineExtension[] = Object.freeze([
  asFactory(piSubagentRecordWatchdog, "larkin-pi-subagent-watchdog"),
  bundledSubagentsExtension,
  asFactory(bashTimeoutExtension, "larkin-pi-bash-timeout"),
]);

type PiMain = (args: string[], options?: MainOptions) => Promise<void>;

/** Invoke Pi RPC with Larkin's builtin-only extension factories. */
export async function invokeBuiltinPiRpc(piMain: PiMain, rest: readonly string[]): Promise<void> {
  await piMain(["--mode", "rpc", ...rest], {
    extensionFactories: [...BUILTIN_PI_EXTENSION_FACTORIES],
  });
}
