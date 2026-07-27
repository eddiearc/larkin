// Development-only Git/source dependencies need to build dist from the checkout.
// Formal native packages are assembled from temporary staging and omit this hook.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.join(ROOT, "scripts", "build.mjs");

if (!fs.existsSync(builder)) process.exit(0);

const result = spawnSync(process.execPath, [builder], { cwd: ROOT, stdio: "inherit" });
if (result.error) {
  console.error(`[prepare] 构建启动失败: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
