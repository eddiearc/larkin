import fs from "node:fs";
import path from "node:path";
import { currentProcessMetadata } from "../../dist/platform/process-state.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
if (!root) throw new Error("LARKIN_CONFIG_DIR missing");
fs.writeFileSync(path.join(root, "dashboard-status.json"), `${JSON.stringify({
  ...currentProcessMetadata("dashboard-stable.mjs"),
  pid: process.pid,
  commandToken: "dashboard-stable.mjs",
  url: "http://localhost:19996",
  startedAt: new Date().toISOString(),
}, null, 2)}\n`, { mode: 0o600 });

process.once("SIGTERM", () => process.exit(0));
process.once("SIGINT", () => process.exit(0));
setInterval(() => {}, 60_000);
