import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  acquireProcessLock,
  readProcessState,
  terminateOwnedProcess,
  waitForProcessExit,
  type OwnedProcessRecord,
} from "../platform/process-state.js";
import { processCommandToken } from "../app/internal-command.js";

const PUBLISHED_RUNTIME_DIRS = ["dist", "assets"];
const RUNTIME_EXTENSIONS = new Set([".cjs", ".mjs", ".js", ".css", ".json", ".node", ".svg", ".wasm"]);

export type DashboardLifecycleAction = "start" | "reuse" | "replace" | "refuse";

export interface DashboardLifecycleDecision {
  action: DashboardLifecycleAction;
  reason: string;
}

interface DashboardReconcileDependencies {
  terminate?: (record: OwnedProcessRecord) => unknown;
  wait?: (record: OwnedProcessRecord) => Promise<boolean>;
}

function publishedRuntimeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".tmp") || entry.name.endsWith(".tgz")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name))) files.push(path.relative(root, absolute));
    }
  };
  for (const directory of PUBLISHED_RUNTIME_DIRS) visit(path.join(root, directory));
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

/** Same semver can contain a different local build, so hash every published shell runtime byte. */
export function dashboardBuildFingerprint(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const relative of publishedRuntimeFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function dashboardReuseDecision(
  record: Pick<OwnedProcessRecord, "state"> & { buildFingerprint?: unknown },
  currentFingerprint: string,
): DashboardLifecycleDecision {
  if (record.state === "dead") return { action: "start", reason: "dashboard not running" };
  if (record.state === "unknown") return { action: "refuse", reason: "dashboard process ownership unknown" };
  if (record.state === "mismatch") return { action: "refuse", reason: "dashboard process ownership mismatch" };
  if (record.buildFingerprint === currentFingerprint) return { action: "reuse", reason: "owned dashboard build matches" };
  return {
    action: "replace",
    reason: typeof record.buildFingerprint === "string"
      ? "owned dashboard build fingerprint differs"
      : "owned dashboard has no build fingerprint",
  };
}

export async function reconcileDashboardRecord(
  record: OwnedProcessRecord,
  currentFingerprint: string,
  dependencies: DashboardReconcileDependencies = {},
): Promise<DashboardLifecycleDecision> {
  const decision = dashboardReuseDecision(record, currentFingerprint);
  if (decision.action === "refuse") {
    throw new Error(`dashboard PID ${record.pid ?? "?"} ${decision.reason}（${record.reason || "no detail"}）；拒绝复用、替换或并行启动`);
  }
  if (decision.action !== "replace") return decision;
  const terminate = dependencies.terminate || ((owned: OwnedProcessRecord) => terminateOwnedProcess(owned, "SIGTERM"));
  const wait = dependencies.wait || ((owned: OwnedProcessRecord) => waitForProcessExit(owned));
  terminate(record);
  if (!await wait(record)) throw new Error(`旧 dashboard（pid ${record.pid}）10 秒内未退出；拒绝并行启动`);
  return { action: "start", reason: decision.reason };
}

/**
 * Serialize inspect/replace/start decisions. The caller keeps the lock through listen(),
 * preventing two internal dashboard children from both passing the first-run gap.
 */
export async function prepareDashboardLaunch(
  larkinHome: string,
  currentFingerprint: string,
  lockCommandToken = processCommandToken("dashboard", "app/dashboard.mjs"),
): Promise<{
  action: "start" | "reuse";
  reason: string;
  record: OwnedProcessRecord;
  release: () => void;
}> {
  const lock = acquireProcessLock(path.join(larkinHome, "dashboard-launch.lock.json"), lockCommandToken);
  try {
    const record = readProcessState(larkinHome).dashboard;
    const result = await reconcileDashboardRecord(record, currentFingerprint);
    return { action: result.action as "start" | "reuse", reason: result.reason, record, release: lock.release };
  } catch (error) {
    lock.release();
    throw error;
  }
}
