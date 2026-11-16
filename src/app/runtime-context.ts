type Env = Record<string, string | undefined>;

function hasRuntimeBin(pathValue: string | undefined): boolean {
  if (!pathValue) return false;
  return pathValue.split(process.platform === "win32" ? ";" : ":")
    .some((entry) => /(?:^|[\\/])runtime-bin$/.test(entry));
}

/**
 * Runtime markers are deliberately independent of LARKIN_AGENT_ID. They keep a
 * damaged Runtime environment from falling through to a terminal's activeAgent
 * selection when its per-Agent identity has been stripped.
 */
export function isLarkinRuntimeContext(env: Env = process.env): boolean {
  return env.LARKIN_RUNTIME === "1"
    || Boolean(env.LARKIN_RUNTIME_OBSERVATION_GENERATION)
    || Boolean(env.LARKIN_STATE_DIR)
    || hasRuntimeBin(env.PATH);
}
