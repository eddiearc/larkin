import { loadConfig } from "../platform/config.js";
import { requestSessionRecovery, requestSessionReset, type SessionResetResponse } from "./local-control.js";

interface SessionCliIo { stdout(value: string): void; stderr(value: string): void }

interface SessionArguments { operation: "reset" | "recover"; agentId: string; waitReadyMs: number; reason?: "context-overflow" }

function sanitizeRecoveryReadiness(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { runtime?: unknown; state?: unknown };
  if (!["codex", "claude", "pi"].includes(String(candidate.runtime))
      || !["missing", "unauthenticated", "unavailable", "incompatible", "ready"].includes(String(candidate.state))) return undefined;
  return { runtime: candidate.runtime, state: candidate.state,
    ...(candidate.state === "ready" ? {} : { reason: `Runtime readiness is ${String(candidate.state)}.`, nextAction: "Inspect Runtime/provider configuration, then retry." }) };
}

function parseSessionArguments(args: readonly string[]): SessionArguments {
  if (args[0] !== "reset" && args[0] !== "recover") throw new Error("unsupported session subcommand");
  const operation = args[0];
  const values = new Map<string, string>();
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      if (json) throw new Error("duplicate flag: --json");
      json = true;
      continue;
    }
    if (!["--agent", "--wait-ready", "--reason"].includes(token)) {
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
  const reason = values.get("--reason");
  if (operation === "recover" && reason !== "context-overflow") throw new Error("--reason context-overflow is required for session recover");
  if (operation === "reset" && reason !== undefined) throw new Error("--reason is only valid for session recover");
  return { operation, agentId, waitReadyMs: Math.round(waitSeconds * 1000), ...(reason ? { reason: reason as "context-overflow" } : {}) };
}

export async function runSessionCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    request?: typeof requestSessionReset;
    requestRecovery?: typeof requestSessionRecovery;
    io?: SessionCliIo;
  } = {},
): Promise<number> {
  const io = dependencies.io ?? { stdout: (value) => process.stdout.write(value), stderr: (value) => process.stderr.write(value) };
  const fail = (code: string, message: string, agentId = "invalid"): number => {
    io.stdout(`${JSON.stringify({ ok: false, agent_id: agentId, code, error: message }, null, 2)}\n`);
    return 1;
  };
  let parsed: SessionArguments;
  try { parsed = parseSessionArguments(args); }
  catch (error) { return fail("invalid_arguments", error instanceof Error ? error.message : String(error)); }
  const agentId = parsed.agentId;
  if (typeof env.LARKIN_AGENT_ID === "string" && env.LARKIN_AGENT_ID.trim()) {
    return fail("user_authority_required", parsed.operation === "reset"
      ? "session reset is available only from a user terminal"
      : "session recovery is available only from a user terminal", agentId);
  }
  try {
    const loaded = loadConfig(env);
    const result = parsed.operation === "recover"
      ? await (dependencies.requestRecovery ?? requestSessionRecovery)({
        larkinHome: loaded.config.larkinHome, agentId, reason: parsed.reason!, waitReadyMs: parsed.waitReadyMs,
      })
      : await (dependencies.request ?? requestSessionReset)({
        larkinHome: loaded.config.larkinHome, agentId, waitReadyMs: parsed.waitReadyMs,
      });
    const output = "recoveryCommitted" in result
      ? {
        ok: result.ok, agent_id: result.agentId, recovery_committed: result.recoveryCommitted,
        generation_changed: result.generationChanged, session_changed: result.sessionChanged, turns: result.turns,
        runtime_ready: result.runtimeReady, channel_connected: result.channelConnected, reconnecting: result.reconnecting,
        pending_count: result.pendingCount, rearmed_count: result.rearmedCount, replay_status: result.replayStatus,
        remaining_pending_count: result.remainingPendingCount, ready_for_fresh_scenario: result.readyForFreshScenario,
        inbound_observed: result.inboundObserved, ...(result.code ? { code: result.code } : {}),
        ...(result.error ? { error: "context-overflow recovery failed" } : {}),
        ...(sanitizeRecoveryReadiness(result.readiness) ? { readiness: sanitizeRecoveryReadiness(result.readiness) } : {}),
      }
      : {
        ok: result.ok, agent_id: result.agentId,
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
    const output: Pick<SessionResetResponse, "ok"> & { agent_id: string; code: string; error: string } = {
      ok: false, agent_id: agentId,
      code: /timeout/i.test(message) ? "control_timeout" : "control_unavailable",
      error: parsed.operation === "recover"
        ? (/timeout/i.test(message) ? "session recovery control timed out" : "session recovery control unavailable") : message,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 1;
  }
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  process.exitCode = await runSessionCli(args, env);
}
