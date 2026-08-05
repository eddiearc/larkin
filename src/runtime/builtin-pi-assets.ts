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
