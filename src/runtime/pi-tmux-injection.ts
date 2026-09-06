import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnedTree, writePrivateAtomic } from "./pi-state-dir.js";
import { tmuxAvailable } from "./pi-tmux.js";

declare global {
  var __LARKIN_EMBEDDED_PI_TMUX_BUNDLE__: string | undefined;
}

const BUNDLE_NAME = "pi-tmux.bundle.js";

export function materializeEmbeddedPiTmuxBundle(configDir: string | undefined): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_TMUX_BUNDLE__;
  if (!embedded || !configDir) return null;
  try {
    const dir = ensureOwnedTree(path.resolve(configDir), ["providers", "pi", "extensions"]);
    const target = path.join(dir, BUNDLE_NAME);
    try {
      if (fs.lstatSync(target).isSymbolicLink()) throw new Error("pi-tmux bundle must not be a symlink");
      if (fs.readFileSync(target, "utf8") === embedded) return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writePrivateAtomic(target, embedded);
    return target;
  } catch (error) {
    throw new Error("Could not materialize the Larkin tmux extension", { cause: error });
  }
}

export function bundledPiTmuxExtensionPath(configDir?: string): string | null {
  try {
    const resolved = fileURLToPath(new URL(`./${BUNDLE_NAME}`, import.meta.url));
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to embedded */
  }
  return materializeEmbeddedPiTmuxBundle(configDir);
}

export function resolvePiTmuxExtensionArg(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}, resolveBundle: () => string | null = () => bundledPiTmuxExtensionPath(input.env.LARKIN_CONFIG_DIR),
  available: typeof tmuxAvailable = tmuxAvailable): string | null {
  if (input.platform === "win32" || !available(input.env, input.platform)) return null;
  const bundle = resolveBundle();
  if (!bundle) throw new Error("Larkin tmux extension bundle is missing; rebuild or reinstall Larkin");
  return bundle;
}
