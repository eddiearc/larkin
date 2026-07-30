import path from "node:path";

export const INTERNAL_COMMAND_MARKER = "__internal";

export const INTERNAL_MODES = [
  "run",
  "setup",
  "agent-config",
  "session-cli",
  "lark",
  "runtime-process",
  "dashboard",
  "agent-cli",
  "lark-cli",
  "runtime-model-directory",
  "bot-register",
  "setup-bind",
  "grant-scopes",
  "lark-channel-secret",
] as const;

export type InternalMode = typeof INTERNAL_MODES[number];

export const PROCESS_COMMAND_TOKENS = Object.freeze({
  setup: `${INTERNAL_COMMAND_MARKER} setup`,
  supervisor: `${INTERNAL_COMMAND_MARKER} run`,
  daemon: `${INTERNAL_COMMAND_MARKER} runtime-process`,
  dashboard: `${INTERNAL_COMMAND_MARKER} dashboard`,
});

export function processCommandToken(mode: keyof typeof PROCESS_COMMAND_TOKENS, legacyToken: string): string {
  return process.env.LARKIN_INTERNAL_DISPATCH === "1" ? PROCESS_COMMAND_TOKENS[mode] : legacyToken;
}

export const INTERNAL_AGENT_CLI = "@larkin/internal-agent-cli";

export interface InternalCommandSpec {
  command: string;
  args: string[];
}

export function internalCommandSpec(
  mode: InternalMode,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): InternalCommandSpec {
  if (env.LARKIN_STANDALONE === "1") {
    return { command: process.execPath, args: [INTERNAL_COMMAND_MARKER, mode, ...args] };
  }
  const entry = env.LARKIN_BINARY_ENTRY_PATH || (() => {
    const callerDir = path.dirname(path.resolve(process.argv[1] || "dist/app/binary-entry.mjs"));
    return path.join(path.basename(callerDir) === "setup" ? path.resolve(callerDir, "../app") : callerDir, "binary-entry.mjs");
  })();
  return { command: process.execPath, args: [entry, INTERNAL_COMMAND_MARKER, mode, ...args] };
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function internalCommandShell(mode: InternalMode, env: NodeJS.ProcessEnv = process.env): string {
  const spec = internalCommandSpec(mode, [], env);
  return [spec.command, ...spec.args].map(posixQuote).join(" ");
}
