const REQUIRED = "1.3.14";

function supported(version: unknown): boolean {
  return String(version || "") === REQUIRED;
}

function assertSupportedBun(version: unknown = (globalThis as { Bun?: { version?: string } }).Bun?.version): void {
  if (supported(version)) return;
  throw new Error(`Larkin requires Bun ${REQUIRED} (current: ${version || "unknown"}). Install the pinned toolchain from packageManager before running Larkin.`);
}

assertSupportedBun();
export = { REQUIRED, supported, assertSupportedBun };
