/** Slice (a) stub: builtin Pi profile import was removed. Slice (b) will delete the remaining callers. */
const removed = (): never => {
  throw new Error("builtin Pi was removed; install and log in with the external `pi` CLI");
};

export interface PiProfileMigrationState {
  version: 1;
  agentId: string;
  sourceDir: string;
  sourceDirMode: number;
  sourceCommand: string;
  sourceExecutable: { path: string; sha256: string; bytes: number; mode: number };
  sourceFiles: Record<string, unknown>;
  targetDir: string;
  targetDirExisted: boolean;
  targetDirMode: number;
  targetDirDevice?: number;
  targetDirInode?: number;
  targetEntries: string[];
  priorFiles: Record<string, unknown>;
  afterFiles: Record<string, unknown>;
  sourcePath?: string;
  sourcePackageDir?: string;
  sourcePackageDev?: number;
  sourcePackageIno?: number;
  sourcePackageThemeSha256?: string;
}

export interface PiProfileMigrationPlan {
  state: PiProfileMigrationState;
  sourceBytes: Record<string, Buffer>;
  sourceEnvironment: { PATH?: string; LARKIN_PI_COMMAND?: string; PI_PACKAGE_DIR?: string };
}

export interface ClearStalePiProfileMigrationLockOptions {
  [key: string]: unknown;
}

export function releasePiProfileMigrationLock(_state: PiProfileMigrationState): void {}
export function clearStalePiProfileMigrationLock(..._args: unknown[]): void {}
export function preparePiProfileMigration(
  _env: NodeJS.ProcessEnv,
  _configDir: string,
  _agentId: string,
  _distribution?: "builtin" | "external",
): PiProfileMigrationPlan {
  return removed();
}
export function validatePiProfileMigrationState(_value: unknown): asserts _value is PiProfileMigrationState {
  removed();
}
export function assertPiProfileMigrationAfterState(_state: PiProfileMigrationState): void { removed(); }
export function applyPiProfileMigration(_plan: PiProfileMigrationPlan): void { removed(); }
export function rollbackPiProfileMigration(_state: PiProfileMigrationState): void { removed(); }
