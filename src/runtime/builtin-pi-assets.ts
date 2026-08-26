import fs from "node:fs";
import path from "node:path";

type BuiltinPiAssets = Readonly<{
  packageJson: string;
  darkTheme: string;
  lightTheme: string;
}>;

declare global {
  // Filled by the standalone wrapper. Source-tree execution keeps using the
  // official package's own files in node_modules.
  var __LARKIN_EMBEDDED_BUILTIN_PI_ASSETS__: BuiltinPiAssets | undefined;
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe bundled Pi asset directory: ${directory}`);
  fs.chmodSync(directory, 0o700);
}

function writeEmbeddedFile(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

/** Materialize upstream runtime assets that Bun cannot serve through ordinary fs paths. */
export function prepareBuiltinPiPackageAssets(): void {
  const assets = globalThis.__LARKIN_EMBEDDED_BUILTIN_PI_ASSETS__;
  if (!assets) return;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Error("bundled Pi requires PI_CODING_AGENT_DIR");
  privateDirectory(agentDir);
  const packageDir = path.join(agentDir, ".larkin-official-pi-package");
  const themeDir = path.join(packageDir, "theme");
  privateDirectory(packageDir);
  privateDirectory(themeDir);
  writeEmbeddedFile(path.join(packageDir, "package.json"), assets.packageJson);
  writeEmbeddedFile(path.join(themeDir, "dark.json"), assets.darkTheme);
  writeEmbeddedFile(path.join(themeDir, "light.json"), assets.lightTheme);
  process.env.PI_PACKAGE_DIR = packageDir;
}

export function piChildDistribution(env: NodeJS.ProcessEnv | undefined): "builtin" | "external" {
  return env?.LARKIN_PI_DISTRIBUTION === "builtin" ? "builtin" : "external";
}

/** Host process env may be builtin Pi; only explicit child overrides select bundled assets. */
export function piChildDistributionFromOverrides(
  ...overrides: Array<NodeJS.ProcessEnv | undefined>
): "builtin" | "external" {
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const value = overrides[index]?.LARKIN_PI_DISTRIBUTION;
    if (value === "builtin" || value === "external") return value;
  }
  return "external";
}

function existingPiThemeFile(directory: string): string | undefined {
  const theme = path.join(directory, "dist", "modes", "interactive", "theme", "dark.json");
  try {
    return fs.statSync(theme).isFile() ? theme : undefined;
  } catch {
    return undefined;
  }
}

export function resolveExternalPiPackageDir(directory: string | undefined): string | undefined {
  if (!directory?.trim()) return undefined;
  try {
    const resolved = fs.realpathSync(directory);
    return existingPiThemeFile(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export function isLarkinBuiltinPiPackageDir(directory: string | undefined): boolean {
  if (!directory) return false;
  try {
    const resolved = fs.realpathSync(directory);
    if (path.basename(resolved).toLowerCase() !== ".larkin-official-pi-package") return false;
    return !existingPiThemeFile(resolved);
  } catch {
    return path.basename(directory).toLowerCase() === ".larkin-official-pi-package";
  }
}

export function catalogPiChildDistribution(commandArgs?: readonly string[]): "builtin" | "external" {
  return commandArgs?.includes("pi-rpc") ? "builtin" : "external";
}

/** External/npm Pi resolves PI_PACKAGE_DIR as a Node package root and looks for dist/themes. */
export function applyPiPackageDirForChild(
  env: NodeJS.ProcessEnv,
  distribution: "builtin" | "external" | { distribution?: "builtin" | "external"; explicitPackageDir?: string } = piChildDistribution(env),
): NodeJS.ProcessEnv {
  const options = typeof distribution === "string" ? { distribution } : distribution;
  const resolved = options.distribution ?? piChildDistribution(env);
  const next = { ...env };
  if (resolved === "builtin") return next;
  const kept = resolveExternalPiPackageDir(options.explicitPackageDir) ?? resolveExternalPiPackageDir(next.PI_PACKAGE_DIR);
  if (kept) next.PI_PACKAGE_DIR = kept;
  else delete next.PI_PACKAGE_DIR;
  return next;
}
