import { describe, expect, it } from "vitest";
import { createLatestResponseGate, filterAgents, parseRoute, reconcileAgentId, routeSearch } from "../../src/dashboard/web/dashboard-state";

describe("dashboard route and selection state", () => {
  it("round-trips an Agent deep link and rejects unknown tabs", () => {
    expect(parseRoute(routeSearch("cli_AgentB2", "advanced"))).toEqual({ agentId: "cli_AgentB2", tab: "advanced" });
    expect(parseRoute("?agent=cli_AgentB2&tab=unknown")).toEqual({ agentId: "cli_AgentB2", tab: "activity" });
  });

  it("maps links to the old tabs onto the page that now holds them", () => {
    expect(parseRoute("?agent=a&tab=overview").tab).toBe("activity");
    expect(parseRoute("?agent=a&tab=conversation").tab).toBe("activity");
    expect(parseRoute("?agent=a&tab=reminders").tab).toBe("activity");
    expect(parseRoute("?agent=a&tab=rules").tab).toBe("persona");
    expect(parseRoute("?agent=a&tab=configuration").tab).toBe("persona");
    expect(parseRoute("?agent=a&tab=runtime").tab).toBe("persona");
    expect(parseRoute("?agent=a&tab=workspace").tab).toBe("advanced");
    expect(parseRoute("?agent=a&tab=logs").tab).toBe("advanced");
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
