import fs from "node:fs";
import path from "node:path";
import { dashboardBuildFingerprint } from "../dashboard/dashboard-lifecycle.js";

declare const LARKIN_BUILD_VERSION: string | undefined;
declare const LARKIN_BUILD_FINGERPRINT: string | undefined;

export function packageVersion(root: string): string {
  if (typeof LARKIN_BUILD_VERSION !== "undefined" && LARKIN_BUILD_VERSION) return LARKIN_BUILD_VERSION;
  try {
    return String((JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string }).version || "dev");
  } catch {
    return "dev";
  }
}

export function buildFingerprint(root: string): string {
  if (typeof LARKIN_BUILD_FINGERPRINT !== "undefined" && LARKIN_BUILD_FINGERPRINT) return LARKIN_BUILD_FINGERPRINT;
  return dashboardBuildFingerprint(root);
}
