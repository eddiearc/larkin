import { spawnSync } from "node:child_process";
import { readProcessState, type OwnedProcessRecord } from "../platform/process-state.js";

export interface DashboardReadiness {
  state: "owned" | "timeout";
  url?: string;
}

export async function waitForOwnedDashboard(
  configDir: string,
  {
    timeoutMs = 15_000,
    pollMs = 100,
    readDashboard = (root: string): OwnedProcessRecord => readProcessState(root).dashboard,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    readDashboard?: (root: string) => OwnedProcessRecord;
  } = {},
): Promise<DashboardReadiness> {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = readDashboard(configDir);
    if (state.state === "owned" && typeof state.url === "string" && state.url) {
      return { state: "owned", url: state.url };
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  return { state: "timeout" };
}

export function openBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

export async function openOwnedDashboardWhenReady(
  configDir: string,
  {
    opener = openBrowser,
    ...readinessOptions
  }: Parameters<typeof waitForOwnedDashboard>[1] & { opener?: (url: string) => boolean } = {},
): Promise<{ readiness: DashboardReadiness; opened: boolean }> {
  const readiness = await waitForOwnedDashboard(configDir, readinessOptions);
  if (readiness.state !== "owned" || !readiness.url) return { readiness, opened: false };
  return { readiness, opened: opener(readiness.url) };
}
