import { describe, expect, it } from "vitest";
import { createLatestResponseGate, filterAgents, parseRoute, reconcileAgentId, routeSearch } from "../../src/dashboard/web/dashboard-state";

describe("dashboard route and selection state", () => {
  it("round-trips an Agent deep link and rejects unknown tabs", () => {
    expect(parseRoute(routeSearch("cli_AgentB2", "configuration"))).toEqual({ agentId: "cli_AgentB2", tab: "configuration" });
    expect(parseRoute("?agent=cli_AgentB2&tab=unknown")).toEqual({ agentId: "cli_AgentB2", tab: "overview" });
  });

  it("falls back when the selected Agent disappears and filters by name or App ID", () => {
    const agents = [{ agentId: "cli_AgentA1", displayName: "研究员" }, { agentId: "cli_AgentB2", displayName: "Builder" }];
    expect(reconcileAgentId("cli_missing", agents)).toBe("cli_AgentA1");
    expect(filterAgents(agents, "builder").map((agent) => agent.agentId)).toEqual(["cli_AgentB2"]);
    expect(filterAgents(agents, "agenta1").map((agent) => agent.agentId)).toEqual(["cli_AgentA1"]);
  });

  it("accepts only the latest issued response", () => {
    const gate = createLatestResponseGate();
    const older = gate.issue();
    const newer = gate.issue();
    expect(gate.accepts(older)).toBe(false);
    expect(gate.accepts(newer)).toBe(true);
  });
});
