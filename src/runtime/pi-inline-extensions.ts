import { pathToFileURL } from "node:url";
import type { ExtensionAPI, InlineExtension, MainOptions } from "@earendil-works/pi-coding-agent";
import bashTimeoutExtension from "./pi-bash-timeout-extension.js";
import { bundledPiSubagentExtensionPath } from "./pi-subagent-injection.js";
import piSubagentRecordWatchdog from "./pi-subagent-record-watchdog.js";

declare global {
  // eslint-disable-next-line no-var
  var __LARKIN_COMPILED_PI_SUBAGENTS__: InlineExtension | undefined;
}

/**
 * Load the prebuilt, patched subagent bundle shipped in dist/ rather than the
 * package-manager copy. Standalone binaries additionally load the patched
 * package through Bun's compiled module graph, while normal package installs
 * continue to use the prebuilt patched bundle.
 */
async function loadBundledPiSubagentExtension(): Promise<InlineExtension> {
  // Compiled standalone already has the patched package in Bun's module graph.
  // The materialized sibling bundle externalizes @earendil-works/pi-coding-agent
  // and cannot be imported from LARKIN_CONFIG_DIR.
  if (process.env.LARKIN_STANDALONE === "1") {
    const loaded = globalThis.__LARKIN_COMPILED_PI_SUBAGENTS__;
    if (typeof loaded !== "function" && (!loaded || typeof loaded.factory !== "function")) {
      throw new Error("Larkin compiled pi-subagents factory is missing; refusing to start builtin Pi");
    }
    return loaded;
  }
  const bundle = bundledPiSubagentExtensionPath(process.env.LARKIN_CONFIG_DIR);
  if (!bundle) throw new Error("Larkin bounded pi-subagents bundle is unavailable; refusing to start builtin Pi");
  const loaded = await import(pathToFileURL(bundle).href) as { default?: InlineExtension };
  if (!loaded.default) throw new Error("Larkin bounded pi-subagents bundle is invalid; refusing to start builtin Pi");
  return loaded.default;
}

function asFn(mod: unknown, name: string): (pi: ExtensionAPI) => void | Promise<void> {
  if (typeof mod === "function") return mod as (pi: ExtensionAPI) => void | Promise<void>;
  const fallback = (mod as { default?: unknown } | undefined)?.default;
  if (typeof fallback === "function") return fallback as (pi: ExtensionAPI) => void | Promise<void>;
  throw new Error(`${name} extension factory is missing`);
}

function wrapFactory(name: string, factory: (pi: ExtensionAPI) => void | Promise<void>): InlineExtension {
  return async (pi) => {
    try {
      await factory(pi);
    } catch (error) {
      throw error instanceof Error ? error : new Error(`${name}: ${String(error)}`);
    }
  };
}

/** Builtin Pi extensions are loaded as code, never through Pi's path/data-URL loader. */
const bundledSubagentsExtension: InlineExtension = async (pi) => {
  const extension = await loadBundledPiSubagentExtension();
  if (typeof extension === "function") await extension(pi);
  else await extension.factory(pi);
};

// Watchdog must register session_shutdown before the bundled subagent extension
// so the final sweep can still read AgentManager.getRecord and bridge consumed
// terminals before manager teardown.
export const BUILTIN_PI_EXTENSION_FACTORIES: readonly InlineExtension[] = Object.freeze([
  wrapFactory("larkin-pi-subagent-watchdog", asFn(piSubagentRecordWatchdog, "larkin-pi-subagent-watchdog")),
  wrapFactory("larkin-pi-subagents", bundledSubagentsExtension),
  wrapFactory("larkin-pi-bash-timeout", asFn(bashTimeoutExtension, "larkin-pi-bash-timeout")),
]);

type PiMain = (args: string[], options?: MainOptions) => Promise<void>;

/** Invoke Pi RPC with Larkin's builtin-only extension factories. */
export async function invokeBuiltinPiRpc(piMain: PiMain, rest: readonly string[]): Promise<void> {
  await piMain(["--mode", "rpc", ...rest], {
    extensionFactories: [...BUILTIN_PI_EXTENSION_FACTORIES],
  });
}
