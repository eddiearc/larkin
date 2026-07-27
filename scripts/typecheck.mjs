import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const WEB = path.join(SRC, "dashboard", "web");
const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");

function discover(directory, pattern, excluded = null) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && absolute !== excluded) files.push(...discover(absolute, pattern, excluded));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

function run(label, args) {
  const result = spawnSync(process.execPath, [tsc, "--ignoreConfig", "--noEmit", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status === 0 && !result.error) return;
  process.stderr.write(result.stderr || result.stdout || `[typecheck] ${label} failed: ${result.error?.message || result.status}\n`);
  process.exit(1);
}

const common = ["--target", "es2022", "--strict", "--skipLibCheck", "--esModuleInterop"];
run("shell", [
  ...common,
  "--types", "node",
  "--module", "nodenext",
  "--moduleResolution", "nodenext",
  ...discover(SRC, /\.(?:ts|cts)$/, WEB).filter((file) => !file.endsWith(".d.ts")),
]);
run("dashboard", [
  ...common,
  "--types", "node,vite/client",
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--jsx", "react-jsx",
  "--lib", "es2022,dom,dom.iterable",
  ...discover(WEB, /\.(?:ts|tsx)$/),
]);
console.error("[typecheck] shell + dashboard PASS");
