import crypto from "node:crypto";
import { loadConfig } from "../platform/config.js";
import { requestSessionReset, type SessionResetResponse } from "./local-control.js";

interface SessionCliIo { stdout(value: string): void; stderr(value: string): void }

interface ResetArguments { agentId: string; waitReadyMs: number; operationId?: string }

function parseResetArguments(args: readonly string[]): ResetArguments {
  if (args[0] !== "reset") throw new Error("unsupported session subcommand");
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      if (json) throw new Error("duplicate flag: --json");
      json = true;
      continue;
    }
    if (!["--agent", "--wait-ready", "--operation-id"].includes(token)) {
      throw new Error(token.startsWith("-") ? `unknown flag: ${token}` : `unexpected positional: ${token}`);
    }
    if (values.has(token)) throw new Error(`duplicate flag: ${token}`);
    const value = args[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`missing value: ${token}`);
    values.set(token, value);
    index += 1;
  }
  if (!json) throw new Error("--json is required");
  const agentId = values.get("--agent");
  if (!agentId || !/^cli_[A-Za-z0-9]+$/.test(agentId)) throw new Error("--agent requires an exact App ID");
  const waitSeconds = Number(values.get("--wait-ready") ?? "30");
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 300) throw new Error("--wait-ready must be 0..300 seconds");
  const operationId = values.get("--operation-id");
  if (operationId && !/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) throw new Error("--operation-id has an invalid format");
  return { agentId, waitReadyMs: Math.round(waitSeconds * 1000), ...(operationId ? { operationId } : {}) };
}

export async function runSessionCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    request?: typeof requestSessionReset;
    io?: SessionCliIo;
    operationId?: () => string;
  } = {},
): Promise<number> {
  const io = dependencies.io ?? { stdout: (value) => process.stdout.write(value), stderr: (value) => process.stderr.write(value) };
  const fail = (code: string, message: string, operationId = "invalid", agentId = "invalid"): number => {
    io.stdout(`${JSON.stringify({ ok: false, operation_id: operationId, agent_id: agentId, code, error: message }, null, 2)}\n`);
    return 1;
  };
  let parsed: ResetArguments;
  try { parsed = parseResetArguments(args); }
  catch (error) { return fail("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  const operationId = parsed.operationId ?? (dependencies.operationId ?? crypto.randomUUID)();
  const agentId = parsed.agentId;
  if (typeof env.LARKIN_AGENT_ID === "string" && env.LARKIN_AGENT_ID.trim()) {
    return fail("user_authority_required", "session reset is available only from a user terminal", operationId, agentId);
  }
  try {
    const loaded = loadConfig(env);
    const result = await (dependencies.request ?? requestSessionReset)({
      larkinHome: loaded.config.larkinHome, agentId, operationId, waitReadyMs: parsed.waitReadyMs,
    });
    const output = {
      ok: result.ok, operation_id: result.operationId, agent_id: result.agentId,
      reset_committed: result.resetCommitted, generation_changed: result.generationChanged,
      session_changed: result.sessionChanged, turns: result.turns, runtime_ready: result.runtimeReady,
      channel_connected: result.channelConnected, reconnecting: result.reconnecting,
      pending_count: result.pendingCount, ready_for_fresh_scenario: result.readyForFreshScenario,
      inbound_observed: result.inboundObserved, ...(result.code ? { code: result.code } : {}),
      ...(result.error ? { error: result.error } : {}), ...(result.readiness ? { readiness: result.readiness } : {}),
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output: Pick<SessionResetResponse, "ok"> & { operation_id: string; agent_id: string; code: string; error: string } = {
      ok: false, operation_id: operationId, agent_id: agentId,
      code: /timeout/i.test(message) ? "control_timeout" : "control_unavailable", error: message,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 1;
  }
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  process.exitCode = await runSessionCli(args, env);
}
