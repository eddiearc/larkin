import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchedSubagentRecordDir, sweepAbsentPiSubagentRecordFiles } from "./pi-subagent-ledger.js";

const PI_SUBAGENTS_MANAGER = Symbol.for("pi-subagents:manager");
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

interface PiSubagentsManagerRegistry {
  getRecord?: (id: string) => unknown;
}

/**
 * Pi-process watchdog: delete Larkin record sidecars once AgentManager no longer
 * has the in-memory task. Leftover transcripts are intentionally ignored.
 */
export default function piSubagentRecordWatchdog(pi: ExtensionAPI): void {
  const stateDir = process.env.LARKIN_STATE_DIR;
  if (!stateDir) return;
  const recordDir = dispatchedSubagentRecordDir(stateDir);
  const intervalMs = sweepIntervalMs();
  const tick = (): void => {
    const manager = (globalThis as Record<symbol, PiSubagentsManagerRegistry | undefined>)[PI_SUBAGENTS_MANAGER];
    if (typeof manager?.getRecord !== "function") return;
    sweepAbsentPiSubagentRecordFiles(recordDir, (taskId) => manager.getRecord!(taskId));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    tick();
  };
  pi.on("session_shutdown", stop);
}

function sweepIntervalMs(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_SUBAGENT_RECORD_SWEEP_MS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return DEFAULT_SWEEP_INTERVAL_MS;
}
