/** Session-scoped bash wait caps for nested Pi subagents (issue #161). */
const WAIT_KEY = Symbol.for("larkin-pi-subagent-bash-wait");

type WaitMap = WeakMap<object, number>;

function waitMap(): WaitMap {
  const bag = globalThis as Record<symbol, WaitMap | undefined>;
  bag[WAIT_KEY] ??= new WeakMap();
  return bag[WAIT_KEY];
}

export function setSubagentBashWaitSeconds(sessionManager: object, seconds: number): void {
  waitMap().set(sessionManager, seconds);
}

export function getSubagentBashWaitSeconds(sessionManager: object | undefined): number | undefined {
  return sessionManager ? waitMap().get(sessionManager) : undefined;
}

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
