export const AGENT_TABS = ["activity", "persona", "reply", "advanced"] as const;
export type AgentTab = typeof AGENT_TABS[number];

/** Tab ids from the earlier seven-tab layout, so saved links still open the page that now holds that content. */
const LEGACY_TABS: Record<string, AgentTab> = {
  overview: "activity", conversation: "activity", reminders: "activity",
  rules: "persona", configuration: "persona", runtime: "persona", workspace: "advanced", logs: "advanced",
};

export interface RouteState {
  agentId: string | null;
  tab: AgentTab;
}

export function parseRoute(search: string): RouteState {
  const params = new URLSearchParams(search);
  const candidate = params.get("tab");
  return {
    agentId: params.get("agent"),
    tab: AGENT_TABS.includes(candidate as AgentTab) ? candidate as AgentTab : LEGACY_TABS[candidate || ""] || "activity",
  };
}

export function routeSearch(agentId: string | null, tab: AgentTab): string {
  const params = new URLSearchParams();
  if (agentId) params.set("agent", agentId);
  params.set("tab", tab);
  return `?${params.toString()}`;
}

export function reconcileAgentId(requested: string | null, agents: Array<{ agentId: string }>): string | null {
  if (requested && agents.some((agent) => agent.agentId === requested)) return requested;
  return agents[0]?.agentId || null;
}

export function filterAgents<T extends { agentId: string; displayName?: string; name?: string }>(agents: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return agents;
  return agents.filter((agent) => [agent.agentId, agent.displayName, agent.name]
    .some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
}

export function sameDraft(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createLatestResponseGate(): { issue: () => number; accepts: (token: number) => boolean } {
  let latest = 0;
  return {
    issue: () => ++latest,
    accepts: (token) => token === latest,
  };
}
