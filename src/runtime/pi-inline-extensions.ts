import subagentsExtension from "@tintinweb/pi-subagents/dist/index.js";
import type { InlineExtension, MainOptions } from "@earendil-works/pi-coding-agent";
import bashTimeoutExtension from "./pi-bash-timeout-extension.js";

/** Builtin Pi extensions are loaded as code, never through Pi's path/data-URL loader. */
export const BUILTIN_PI_EXTENSION_FACTORIES: readonly InlineExtension[] = Object.freeze([
  subagentsExtension as unknown as InlineExtension,
  bashTimeoutExtension,
]);

type PiMain = (args: string[], options?: MainOptions) => Promise<void>;

/** Invoke Pi RPC with Larkin's builtin-only extension factories. */
export async function invokeBuiltinPiRpc(piMain: PiMain, rest: readonly string[]): Promise<void> {
  await piMain(["--mode", "rpc", ...rest], {
    extensionFactories: [...BUILTIN_PI_EXTENSION_FACTORIES],
  });
}
