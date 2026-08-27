import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { piVersionSupportsSubagents, probeExternalPiVersion } from "./pi-subagent-injection.js";

declare global {
  var __LARKIN_EMBEDDED_PI_SUBAGENT_RECORD_WATCHDOG_BUNDLE__: string | undefined;
}

export function materializeEmbeddedPiSubagentRecordWatchdogBundle(configDir: string | undefined): string | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_PI_SUBAGENT_RECORD_WATCHDOG_BUNDLE__;
  if (!embedded || !configDir) return null;
  const dir = path.join(path.resolve(configDir), "providers", "pi", "extensions");
  const target = path.join(dir, "pi-subagent-record-watchdog.bundle.js");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== embedded) {
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, embedded, { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
    }
    return target;
  } catch {
    return null;
  }
}

export function bundledPiSubagentRecordWatchdogExtensionPath(configDir?: string): string | null {
  try {
    const url = new URL("./pi-subagent-record-watchdog.bundle.js", import.meta.url);
    const resolved = fileURLToPath(url);
    if (fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to embedded */
  }
  return materializeEmbeddedPiSubagentRecordWatchdogBundle(configDir);
}

export function resolvePiSubagentRecordWatchdogExtensionArg(
  input: { distribution: "external"; piCommand: string; env: NodeJS.ProcessEnv },
  probeVersion: () => { major: number; minor: number } | null = () => probeExternalPiVersion(input.piCommand, input.env),
  resolveBundle: () => string | null = () => bundledPiSubagentRecordWatchdogExtensionPath(input.env.LARKIN_CONFIG_DIR),
): string | null {
  const bundle = resolveBundle();
  if (!bundle) return null;
  return piVersionSupportsSubagents(probeVersion()) ? bundle : null;
}
