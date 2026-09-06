import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Same implicit root the Pi adapter uses when `stateDir` is omitted. */
export function effectivePiStateDir(input: { workspaceDir: string; stateDir?: string }): string {
  return input.stateDir ?? path.join(input.workspaceDir, ".larkin");
}

/**
 * 从 root 起逐层建 0700 子树。root 可以位于 /var、/tmp 等合法祖先 link 之后；
 * 任一层 owned 组件自身是 symlink 则拒绝，不顺着 link 往外写。
 */
export function ensureOwnedTree(root: string, parts: readonly string[] = [], create = true): string {
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe private directory: ${resolved}`);
  } else if (create) {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(resolved).isSymbolicLink() || !fs.lstatSync(resolved).isDirectory()) {
      throw new Error(`unsafe private directory: ${resolved}`);
    }
  } else {
    throw new Error(`unsafe private directory: ${resolved}`);
  }
  let dir = resolved;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || /[\\/]/.test(part)) throw new Error(`unsafe owned path component: ${part}`);
    dir = path.join(dir, part);
    try {
      const existing = fs.lstatSync(dir);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`unsafe private directory: ${dir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new Error(`unsafe private directory: ${dir}`);
      fs.mkdirSync(dir, { mode: 0o700 });
      if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) throw new Error(`unsafe private directory: ${dir}`);
    }
    if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  }
  return dir;
}

export function ensurePrivateDirectory(directory: string): void {
  ensureOwnedTree(directory);
}

/** 独占新建 0700 目录；已存在或变成 symlink 都拒绝。 */
export function mkdirPrivateExclusive(directory: string): void {
  fs.mkdirSync(directory, { mode: 0o700 });
  const created = fs.lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`unsafe private directory: ${directory}`);
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

/** 独占新建 0600 文件；已存在（含 symlink）时失败，不跟随写出。 */
export function writePrivateExclusive(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") fs.chmodSync(file, 0o600);
}

/** 原子写 0600 文件；目标或父目录已是 symlink 时拒绝，避免落到目录外。 */
export function writePrivateAtomic(file: string, content: string): void {
  try {
    if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error(`unsafe private directory: ${path.dirname(file)}`);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${path.basename(file)} must not be a symlink`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}
