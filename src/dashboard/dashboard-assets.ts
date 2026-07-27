import fs from "node:fs";
import path from "node:path";

export type DashboardAssetName = "larkin-mark.svg" | "dashboard.css" | "dashboard.js";

declare global {
  // Filled by scripts/release/standalone-entry.ts before the compiled app starts.
  // eslint-disable-next-line no-var
  var __LARKIN_EMBEDDED_DASHBOARD_ASSETS__: Readonly<Record<DashboardAssetName, Uint8Array>> | undefined;
}

const MIME_TYPES: Record<DashboardAssetName, string> = {
  "larkin-mark.svg": "image/svg+xml",
  "dashboard.css": "text/css; charset=utf-8",
  "dashboard.js": "text/javascript; charset=utf-8",
};

export interface DashboardAsset {
  body: Uint8Array;
  contentType: string;
  embedded: boolean;
}

export function dashboardAsset(name: DashboardAssetName, root: string): DashboardAsset | null {
  const embedded = globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__?.[name];
  if (embedded) return { body: embedded, contentType: MIME_TYPES[name], embedded: true };
  const file = name === "larkin-mark.svg"
    ? path.join(root, "assets", name)
    : path.join(root, "dist", "dashboard", "web", "assets", name);
  try {
    return { body: fs.readFileSync(file), contentType: MIME_TYPES[name], embedded: false };
  } catch {
    return null;
  }
}
