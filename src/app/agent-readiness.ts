import type { OwnedProcessRecord } from "../platform/process-state.js";
import { daemonHasAgent } from "../platform/process-state.js";

export interface AgentReadinessStatus {
  connectedAt?: string;
  connectedVia?: string;
  inboundVerifiedAt?: string;
  reconnectingAt?: string | null;
  reconnectedAt?: string | null;
  runtimeReadiness?: { state?: "missing" | "unauthenticated" | "incompatible" | "ready" };
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectAgentReadiness(input: {
  agentId: string;
  daemon: OwnedProcessRecord;
  status?: AgentReadinessStatus | null;
}): {
  ready: boolean;
  readiness: {
    daemon_owned: boolean;
    runtime_ready: boolean;
    channel_connected: boolean;
    channel_not_reconnecting: boolean;
  };
  channel: { connected_at: string | null; connected_via: string | null; inbound_verified_at: string | null };
} {
  const status = input.status ?? null;
  const daemonOwned = daemonHasAgent(input.daemon, input.agentId);
  const daemonStartedAt = timestamp(input.daemon.startedAt);
  const connectedAt = timestamp(status?.connectedAt);
  const channelConnected = daemonOwned
    && status?.connectedVia === "channel"
    && daemonStartedAt !== null
    && connectedAt !== null
    && connectedAt >= daemonStartedAt;
  const reconnectingAt = timestamp(status?.reconnectingAt);
  const reconnectedAt = timestamp(status?.reconnectedAt);
  const latestConnectedAt = Math.max(connectedAt ?? Number.NEGATIVE_INFINITY, reconnectedAt ?? Number.NEGATIVE_INFINITY);
  const reconnecting = reconnectingAt !== null && reconnectingAt > latestConnectedAt;
  const readiness = {
    daemon_owned: daemonOwned,
    runtime_ready: status?.runtimeReadiness?.state === "ready",
    channel_connected: channelConnected,
    channel_not_reconnecting: !reconnecting,
  };
  return {
    ready: Object.values(readiness).every(Boolean),
    readiness,
    channel: {
      connected_at: connectedAt === null ? null : status?.connectedAt ?? null,
      connected_via: status?.connectedVia || null,
      inbound_verified_at: timestamp(status?.inboundVerifiedAt) === null ? null : status?.inboundVerifiedAt ?? null,
    },
  };
}
