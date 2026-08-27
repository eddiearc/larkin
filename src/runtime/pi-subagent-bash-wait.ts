/** Parse Agent max_command_wait_seconds. Nested bash caps are closures, not a global map. */

export function parseMaxCommandWaitSeconds(value: unknown, runInBackground: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (runInBackground !== true) {
    throw new Error("max_command_wait_seconds requires run_in_background: true");
  }
  if (!Number.isInteger(value) || Number(value) < 61 || Number(value) > 600) {
    throw new Error("max_command_wait_seconds must be an integer 61..600");
  }
  return Number(value);
}
