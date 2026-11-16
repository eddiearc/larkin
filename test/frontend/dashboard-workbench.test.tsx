import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, useStatusPolling } from "../../src/dashboard/web/app";

const agents = [
  {
    agentId: "cli_AgentA1", name: "cli_AgentA1", displayName: "研究员", runtime: "pi", model: "default", effort: null,
    runtimeReadiness: null,
    running: true, issue: false, credentialReady: true, bot: null,
    connection: { state: "connected", reason: "current channel" }, inbound: { state: "pending", reason: "waiting" },
    lastActivity: { state: "working", detail: "整理资料", ageSec: 8 }, lastDeliver: { from: "idan", target: "#research", ageSec: 12 },
    eyeIndicator: { pendingCount: 0, oldestAgeSec: null, stuck: false }, activeReminders: 1,
    remindersList: [{ title: "同步进度", status: "pending", fireAt: "2026-07-24T12:00:00.000Z" }],
    session: null, conversation: [], feed: [], recentErrors: [], knownChats: 0,
  },
  {
    agentId: "cli_AgentB2", name: "cli_AgentB2", displayName: "Builder", runtime: "codex", model: "gpt-5.6-sol", effort: "high",
    runtimeReadiness: null as {
      runtime: "codex" | "claude" | "pi";
      state: "missing" | "unauthenticated" | "incompatible" | "ready";
      reason?: string;
      nextAction?: string;
    } | null,
    running: true, issue: false, credentialReady: true, bot: null,
    connection: { state: "connected", reason: "current channel" }, inbound: { state: "verified", reason: "observed" },
    lastActivity: { state: "idle", detail: "等待任务", ageSec: 18 }, lastDeliver: { from: "idan", target: "#build", ageSec: 22 },
    eyeIndicator: { pendingCount: 0, oldestAgeSec: null, stuck: false }, activeReminders: 0, remindersList: [],
    session: {
      id: "session-builder", runtime: "codex", ageSec: 200, lastTurnAt: null, turns: 3,
      usage: { available: true, cumulativeTokens: 12_345, latestTokens: 678, contextWindow: 2_000, contextPercent: 34 },
      compaction: { active: false, count: 2, countSource: "runtime", lastFinishedAt: "2026-07-24T09:00:00.000Z" },
    },
    conversation: [
      { direction: "out", from: "Builder", target: "#build", wake: false, text: "构建完成", at: "2026-07-24T10:02:00.000Z" },
      { direction: "in", from: "旁听用户", target: "#build", wake: false, text: "这条只进入上下文", at: "2026-07-24T10:01:00.000Z" },
      { direction: "in", from: "idan", target: "#build", wake: true, text: "请开始构建", at: "2026-07-24T10:00:00.000Z" },
    ],
    feed: [{ kind: "activity", state: "idle", detail: "等待任务", at: "2026-07-24T10:00:00.000Z" }], recentErrors: [], knownChats: 1,
  },
  {
    agentId: "cli_AgentC3", name: "cli_AgentC3", displayName: "Pi Agent", runtime: "pi", model: "deepseek/deepseek-v4-pro", effort: null,
    runtimeReadiness: null,
    running: true, issue: false, credentialReady: false, bot: null,
    connection: { state: "connected", reason: "current channel" }, inbound: { state: "pending", reason: "waiting" },
    lastActivity: { state: "idle", detail: "等待任务", ageSec: 30 }, lastDeliver: null,
    eyeIndicator: { pendingCount: 0, oldestAgeSec: null, stuck: false }, activeReminders: 0, remindersList: [],
    session: null, conversation: [], feed: [], recentErrors: [], knownChats: 0,
  },
];

const status = {
  version: "0.2.20+test", packageVersion: "0.2.20", buildFingerprint: "sha256:test", generatedAt: "2026-07-24T10:00:00.000Z",
  daemon: { running: true, state: "owned", reason: null, uptimeSec: 100, agents: agents.map((agent) => agent.agentId) }, agents,
};

const config = (agentId?: string) => ({
  version: 4, mentionPolicy: "free", inboxAudit: { enabled: false, intervalMs: 15 * 60_000 }, persistedRevision: "sha256:revision",
  runtimeModels: {
    pi: [{ id: "default" }],
    codex: [{ id: "default" }, { id: "gpt-5.6-sol", supportedReasoningEfforts: ["low", "high"] }],
    claude: [{ id: "default" }],
  },
  runtimeOptions: ["codex", "claude", "pi"] as const,
  agents: (agentId ? agents.filter((agent) => agent.agentId === agentId) : agents).map((agent) => ({
    agentId: agent.agentId, runtime: agent.runtime,
    runtimeOption: agent.runtime as "codex" | "claude" | "pi",
    model: agent.model, effort: agent.effort,
    mention: { override: agent.agentId === "cli_AgentB2" ? "require" : "inherit", effective: agent.agentId === "cli_AgentB2" ? "require" : "free", source: agent.agentId === "cli_AgentB2" ? "agent" : "global" },
    inboxAudit: {
      override: { enabled: "inherit", intervalMs: "inherit" }, effective: { enabled: false, intervalMs: 15 * 60_000 },
      source: { enabled: "default", intervalMs: "default" },
    },
    knownChats: agent.agentId === "cli_AgentB2" ? [
      { chatId: "oc_BuildRoom", displayName: "构建群", kind: "group", override: "free", effective: "free", source: "chat" },
      { chatId: "oc_InheritedRoom", displayName: "继承群", kind: "group", override: "inherit", effective: "require", source: "agent" },
    ] : [],
    apply: { applyState: "pending" },
  })),
});

function missingRules() {
  return { files: [
    { name: "AGENTS.md", linkedTo: null, file: null, error: null },
    { name: "CLAUDE.md", linkedTo: null, file: null, error: null },
  ] };
}

function ruleFile(name: string, content: string) {
  return { kind: "file", path: name, name, size: content.length, modifiedAt: "2026-10-24T10:00:00.000Z",
    binary: false, truncated: false, content, sha256: "c".repeat(64) };
}

function ok(value: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => value });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=persona");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/status") return ok(status);
    if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
    if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
    if (url.pathname === "/api/agent-rules") return ok(missingRules());
    if (url.pathname === "/api/agent-capabilities") return ok({ runtime: "codex", items: [], unsupported: [] });
    throw new Error(`unexpected request ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent-centric dashboard workbench", () => {
  it("shows the package version in desktop and mobile branding and explains the CLI-first configuration boundary", async () => {
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(screen.getAllByText("v0.2.20")).toHaveLength(2);
    expect(container.querySelector(".app-topbar strong")).toHaveTextContent(/^Larkin v0\.2\.20$/);
    expect(screen.getByRole("tab", { name: "设定" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Agent workbench")).not.toBeInTheDocument();
    const guidance = await screen.findByText(/更多选项可以让 Agent 运行/);
    expect(guidance).toBeVisible();
    expect(guidance).toHaveTextContent(/让 Agent 运行 larkin config --help 自己改/);
  });

  it("renders only explicit group policies without implementation-oriented precedence terminology", async () => {
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=reply");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Builder" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "回复规则" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { level: 3, name: "单独设置的群" })).toBeVisible();
    expect(screen.getByText("构建群")).toBeVisible();
    expect(screen.queryByText("继承群")).not.toBeInTheDocument();
    expect(screen.queryByText(/覆盖链/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/effective/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("搜索群名或 chat_id"), "missing");
    expect(screen.getByText("没有匹配的群")).toBeVisible();
  });

  it("offers the group policy as explained choices", async () => {
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=reply");
    render(<App />);
    const policy = await screen.findByRole("radiogroup", { name: "群消息策略" });
    expect(within(policy).getByRole("radio", { name: /^只回 @ 它的/ })).toBeChecked();
    expect(within(policy).queryByRole("radio", { name: /跟随全局/ })).not.toBeInTheDocument();
    await userEvent.click(within(policy).getByRole("radio", { name: /^每条都看/ }));
    expect(within(policy).getByRole("radio", { name: /^每条都看/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "保存 Agent 配置" })).toBeEnabled();
  });

  it("says what Inbox audit does now and how", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    const toggle = await screen.findByLabelText("Inbox 巡检开关");
    expect(screen.getByRole("note")).toHaveTextContent("已关闭");
    await userEvent.click(toggle);
    expect(screen.getByRole("note")).toHaveTextContent(/约 \d+ 分钟内回头检查一次/);
    expect(screen.getByText("巡检具体怎么做")).toBeVisible();
  });

  it("looks up group names only for the reply tab, not for the other tabs", async () => {
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=reply");
    render(<App />);
    expect(await screen.findByRole("heading", { level: 3, name: "单独设置的群" })).toBeVisible();
    const configReads = () => vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith("/api/config"));
    await waitFor(() => expect(configReads()).toContain("/api/config?agent=cli_AgentB2&chats=0"));
    expect(configReads().filter((url) => !url.includes("chats=0"))).toEqual(["/api/config?agent=cli_AgentB2"]);
    expect(configReads()).toContain("/api/config?agent=cli_AgentB2&chats=0");
  });

  it("has no global settings and protects an Agent draft before navigation", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(screen.queryByRole("button", { name: "全局设置" })).not.toBeInTheDocument();

    const runtime = await screen.findByLabelText("Runtime");
    await userEvent.selectOptions(runtime, "claude");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("option", { name: /研究员/ }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Builder" })).toBeVisible();
    expect(window.location.search).toContain("agent=cli_AgentB2");
  });

  it("saves the Agent's own reply mode and applies it to that Agent", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        mutations.push(JSON.parse(String(init.body)));
        return ok({ revision: "sha256:agent-reply-mode", applyState: "saved_not_applied" });
      }
      if (url.pathname === "/api/config/apply") {
        applied.push(JSON.parse(String(init?.body)).agentId);
        return ok({ ok: true, agentId: "cli_AgentB2", applyState: "applied" });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=reply");
    render(<App />);
    const replyMode = await screen.findByRole("radiogroup", { name: "回复方式" });
    expect(within(replyMode).getByRole("radio", { name: /^普通消息/ })).toBeChecked();
    await userEvent.click(within(replyMode).getByRole("radio", { name: /^流式卡片/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("配置已保存并应用"));
    expect(mutations).toEqual([{ operation: "set-agent-reply-mode", agentId: "cli_AgentB2", value: "card" }]);
    expect(applied).toEqual(["cli_AgentB2"]);
  });

  it("does not expose a processing-eye toggle after the switch was removed", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(screen.queryByLabelText("处理中表情设置")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "处理中表情" })).not.toBeInTheDocument();
  });

  it("turns Inbox audit on per Agent", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        mutations.push(JSON.parse(String(init.body)));
        return ok({ revision: "sha256:agent-audit", applyState: "saved_not_applied" });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    const toggle = await screen.findByLabelText("Inbox 巡检开关");
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "间隔跟随全局设置" })).not.toBeInTheDocument();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    await waitFor(() => expect(mutations).toEqual([{ operation: "set-agent-inbox-audit", agentId: "cli_AgentB2", enabled: true }]));
  });

  it("saves only the open page's fields, so an older draft on another page cannot revert a newer save", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let mention = "require";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        const mutation = JSON.parse(String(init.body));
        mutations.push(mutation);
        if (mutation.operation === "set-agent-mention") mention = mutation.value;
        return ok({ revision: "sha256:next", applyState: "pending" });
      }
      if (url.pathname === "/api/config") {
        const value = config(url.searchParams.get("agent") || undefined);
        for (const agent of value.agents) if (agent.agentId === "cli_AgentB2") agent.mention = { ...agent.mention, override: mention, effective: mention };
        return ok(value);
      }
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    const gap = await screen.findByLabelText("巡检间隔（分钟）");
    await userEvent.clear(gap);
    await userEvent.type(gap, "30");

    await userEvent.click(screen.getByRole("tab", { name: "回复规则" }));
    await userEvent.click(within(await screen.findByRole("radiogroup", { name: "群消息策略" })).getByRole("radio", { name: /^每条都看/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    await waitFor(() => expect(mutations).toEqual([{ operation: "set-agent-mention", agentId: "cli_AgentB2", value: "free" }]));

    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    expect(screen.getByLabelText("巡检间隔（分钟）")).toHaveValue(30);
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toEqual({ operation: "set-agent-inbox-audit", agentId: "cli_AgentB2", intervalMs: 30 * 60_000 });
    expect(mention).toBe("free");
  });

  it("keeps an Agent Inbox audit draft visible after a rejected save", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        mutations.push(JSON.parse(String(init.body)));
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "configuration update rejected" }) });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    await userEvent.click(await screen.findByLabelText("Inbox 巡检开关"));
    const gap = screen.getByLabelText("巡检间隔（分钟）");
    await userEvent.clear(gap);
    await userEvent.type(gap, "0");
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    expect(screen.getByRole("status")).toHaveTextContent("巡检间隔必须在 1 到 1440 分钟之间");
    expect(mutations).toEqual([]);
    await userEvent.clear(gap);
    await userEvent.type(gap, "30");
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    await waitFor(() => expect(mutations).toEqual([{ operation: "set-agent-inbox-audit", agentId: "cli_AgentB2", enabled: true, intervalMs: 30 * 60_000 }]));
    expect(screen.getByRole("status")).toHaveTextContent("configuration update rejected");
    expect(screen.getByLabelText("Inbox 巡检开关")).toBeChecked();
    expect(screen.getByLabelText("巡检间隔（分钟）")).toHaveValue(30);
  });

  it("saves the Codex sandbox from 高级 and applies it like a model change", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        mutations.push(JSON.parse(String(init.body)));
        return ok({ revision: "sha256:sandbox", applyState: "saved_not_applied" });
      }
      if (url.pathname === "/api/config/apply" && init?.method === "POST") {
        applied.push(JSON.parse(String(init.body)).agentId);
        return ok({ ok: true, applyState: "applied" });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    const sandbox = await screen.findByRole("radiogroup", { name: "沙箱模式" });
    expect(within(sandbox).getByRole("radio", { name: /不限制/ })).toBeChecked();
    await userEvent.click(screen.getByText("选「只改自己的工作区」后，具体能改哪些地方"));
    expect(screen.getByText("~/.larkin/agents/cli_AgentB2/")).toBeVisible();
    expect(screen.getByText("~/.larkin/state/agents/cli_AgentB2/")).toBeVisible();
    await userEvent.click(within(sandbox).getByRole("radio", { name: /只改自己的工作区/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await waitFor(() => expect(mutations).toEqual([{ operation: "set-agent-sandbox", agentId: "cli_AgentB2", value: "workspace-write" }]));
    await waitFor(() => expect(applied).toEqual(["cli_AgentB2"]));
  });

  it("turns on Codex Fast mode from the model settings and applies it", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    const applied: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        mutations.push(JSON.parse(String(init.body)));
        return ok({ revision: "sha256:fast", applyState: "saved_not_applied" });
      }
      if (url.pathname === "/api/config/apply" && init?.method === "POST") {
        applied.push(JSON.parse(String(init.body)).agentId);
        return ok({ ok: true, applyState: "applied" });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default", supportsFast: true }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "设定" }));
    const fast = await screen.findByLabelText("Fast 模式");
    await waitFor(() => expect(fast).not.toBeDisabled());
    expect(fast).not.toBeChecked();
    await userEvent.click(fast);
    await userEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    await waitFor(() => expect(mutations).toEqual([{ operation: "set-agent-fast-mode", agentId: "cli_AgentB2", value: true }]));
    await waitFor(() => expect(applied).toEqual(["cli_AgentB2"]));
  });

  it("tells the user to refresh and keeps the draft when a save is rejected as coming from an expired page", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") {
        return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "这个页面已过期，刷新页面后再操作。" }) });
      }
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
      if (url.pathname === "/api/agent-rules") return ok(missingRules());
      if (url.pathname === "/api/agent-capabilities") return ok({ runtime: "codex", items: [], unsupported: [] });
      throw new Error(`unexpected request ${url}`);
    }));
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=reply");
    render(<App />);
    const policy = await screen.findByRole("radiogroup", { name: "群消息策略" });
    await userEvent.click(within(policy).getByRole("radio", { name: /^每条都看/ }));
    await userEvent.click(screen.getByRole("button", { name: "保存 Agent 配置" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("这个页面已过期，刷新页面后再操作"));
    expect(within(policy).getByRole("radio", { name: /^每条都看/ })).toBeChecked();
  });

  it("filters the sidebar and preserves last-known status on polling errors", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.type(screen.getByPlaceholderText("搜索 Agent…"), "研究");
    expect(screen.getByRole("option", { name: /研究员/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Builder/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Builder" })).toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/status", expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("renders production conversation direction, sender, and unawakened listening state", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "动态" }));
    expect(screen.getByText("已发送")).toBeVisible();
    expect(screen.getByText("旁听 · 未唤醒")).toBeVisible();
    expect(screen.getByText("入站 · 已唤醒")).toBeVisible();
    expect(screen.getByText("旁听用户")).toBeVisible();
    expect(screen.getByText("这条只进入上下文")).toBeVisible();
  });

  it("keeps context, cumulative/latest tokens, and compaction summary visible", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(screen.getByText("上下文 34% · 678 / 2,000")).toBeVisible();
    expect(screen.getByText("累计 12,345 tokens")).toBeVisible();
    expect(screen.getByText("最近一轮 678 tokens")).toBeVisible();
    expect(screen.getByText("Compact 2 次 · idle")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "动态" }));
    expect(screen.getByText("累计 Token")).toBeVisible();
    expect(screen.getByText("12,345")).toBeVisible();
    expect(screen.getByText("最近一轮用量")).toBeVisible();
    expect(screen.getByText("输入、缓存与输出合计")).toBeVisible();
    expect(screen.getByText("678")).toBeVisible();
    expect(screen.getByText("Compaction")).toBeVisible();
  });

  it("restores a separate window scroll position for each Agent tab", async () => {
    let scrollY = 0;
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((options) => { scrollY = Number((options as ScrollToOptions).top || 0); });
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    scrollY = 420;
    await userEvent.click(screen.getByRole("tab", { name: "动态" }));
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" }));
    scrollY = 88;
    await userEvent.click(screen.getByRole("tab", { name: "设定" }));
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 420, behavior: "auto" }));
  });

  it("renders a same-origin bot avatar and falls back to initials on proxy failure", async () => {
    const prior = agents[1].bot;
    agents[1].bot = { name: "Builder", hasAvatar: true };
    try {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      const images = [...document.querySelectorAll<HTMLImageElement>('img[src="/api/avatar/cli_AgentB2"]')];
      expect(images).toHaveLength(2);
      expect(vi.mocked(fetch).mock.calls.every(([input]) => !String(input).startsWith("https://"))).toBe(true);
      images.forEach((image) => fireEvent.error(image));
      await waitFor(() => expect(document.querySelector('img[src="/api/avatar/cli_AgentB2"]')).toBeNull());
      expect(screen.getAllByText("BU").length).toBeGreaterThanOrEqual(2);
    } finally { agents[1].bot = prior; }
  });

  it("keeps last-known hook data stale after a polling error and clears it on retry", async () => {
    vi.useFakeTimers();
    const recovered = { ...status, generatedAt: "2026-07-24T10:03:00.000Z" };
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => ok(status))
      .mockRejectedValueOnce(new Error("poll offline"))
      .mockImplementationOnce(() => ok(recovered)));
    const { result, unmount } = renderHook(() => useStatusPolling());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.data).toBe(status);
    await act(async () => { vi.advanceTimersByTime(3_000); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.data).toBe(status);
    expect(result.current.stale).toBe(true);
    expect(result.current.error).toBe("连不上 larkin：服务可能已停止或正在重启。确认 larkin 在运行后刷新页面。");
    await act(async () => { await result.current.retry(); });
    expect(result.current.data).toBe(recovered);
    expect(result.current.stale).toBe(false);
    unmount();
    vi.useRealTimers();
  });

  it("rejects an older hook response after a newer retry completes", async () => {
    const older = deferred<Awaited<ReturnType<typeof ok>>>();
    const newer = deferred<Awaited<ReturnType<typeof ok>>>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));
    const { result, unmount } = renderHook(() => useStatusPolling());
    expect(fetch).toHaveBeenCalledTimes(1);
    let retry!: Promise<void>;
    act(() => { retry = result.current.retry(); });
    await act(async () => { newer.resolve(await ok({ ...status, generatedAt: "newer" })); await retry; });
    expect(result.current.data?.generatedAt).toBe("newer");
    await act(async () => { older.resolve(await ok({ ...status, generatedAt: "older" })); await older.promise; });
    expect(result.current.data?.generatedAt).toBe("newer");
    unmount();
  });

  it("does not let a late previous-Agent config response overwrite the selected Agent", async () => {
    const builderConfig = deferred<Awaited<ReturnType<typeof ok>>>();
    const researcherConfig = deferred<Awaited<ReturnType<typeof ok>>>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && url.searchParams.get("agent") === "cli_AgentB2") return builderConfig.promise;
      if (url.pathname === "/api/config" && url.searchParams.get("agent") === "cli_AgentA1") return researcherConfig.promise;
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("option", { name: /研究员/ }));
    await act(async () => { researcherConfig.resolve(await ok(config("cli_AgentA1"))); });
    expect(await screen.findByLabelText("Runtime")).toHaveValue("pi");
    await act(async () => { builderConfig.resolve(await ok(config("cli_AgentB2"))); });
    expect(screen.getByRole("heading", { level: 1, name: "研究员" })).toBeVisible();
    expect(screen.getByLabelText("Runtime")).toHaveValue("pi");
  });

  it("refreshes pending to applied after a successful Apply", async () => {
    let applyState: "pending" | "applied" = "pending";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") {
        const value = config(url.searchParams.get("agent") || undefined);
        value.agents.forEach((agent) => { agent.apply.applyState = applyState; });
        return ok(value);
      }
      if (url.pathname === "/api/config/apply" && init?.method === "POST") {
        applyState = "applied";
        return ok({ agentId: "cli_AgentB2", applyState });
      }
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default: gpt-5.6-sol" }, { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] });
      if (url.pathname === "/api/models/claude") return ok({ models: [{ id: "default", label: "default: claude-sonnet-5" }, { id: "sonnet", label: "Sonnet" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(await screen.findByText("待应用")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "应用已保存配置" }));
    expect(await screen.findByText("已应用")).toBeVisible();
  });

  it("combines a runtime save and safe apply into one primary action", async () => {
    let applyState: "pending" | "applied" = "pending";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config" && init?.method === "PATCH") return ok({ revision: "sha256:next", applyState: "saved_not_applied" });
      if (url.pathname === "/api/config") {
        const value = config(url.searchParams.get("agent") || undefined);
        value.agents.forEach((agent) => { agent.apply.applyState = applyState; });
        return ok(value);
      }
      if (url.pathname === "/api/config/apply" && init?.method === "POST") {
        applyState = "applied";
        return ok({ agentId: "cli_AgentB2", applyState });
      }
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default: gpt-5.6-sol" }, { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] });
      if (url.pathname === "/api/models/claude") return ok({ models: [{ id: "default", label: "default: claude-sonnet-5" }, { id: "sonnet", label: "Sonnet" }] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.selectOptions(await screen.findByLabelText("Runtime"), "claude");
    await userEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(await screen.findByText("配置已保存并应用")).toBeVisible();
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input) === "/api/config/apply" && init?.method === "POST")).toBe(true);
  });

  it("loads authenticated Pi models from the Agent-scoped Pi model endpoint", async () => {
    window.history.replaceState(null, "", "/?agent=cli_AgentA1&tab=configuration");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/pi") return ok({ models: [
        { id: "default", label: "default: openai/gpt-5.2" },
        { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5 · anthropic", supportedReasoningEfforts: ["off", "high"] },
      ] });
      throw new Error(`unexpected request ${url}`);
    }));

    render(<App />);
    expect(await screen.findByLabelText("Runtime")).toHaveValue("pi");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input) === "/api/models/pi?agent=cli_AgentA1")).toBe(true));
    expect(screen.getByRole("option", { name: "default: openai/gpt-5.2" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Claude Sonnet 4.5 · anthropic" })).toBeVisible();
    expect(screen.queryByLabelText("Pi 发行版")).not.toBeInTheDocument();
    const runtimeSelect = screen.getByLabelText("Runtime");
    expect([...runtimeSelect.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toEqual(["codex", "claude", "pi"]);
    expect(screen.queryByRole("option", { name: "builtin-pi" })).not.toBeInTheDocument();
  });

  it("does not render a Pi distribution control for any runtime", async () => {
    render(<App />);
    expect(await screen.findByLabelText("Runtime")).toHaveValue("codex");
    expect(screen.queryByText("内置 Pi")).not.toBeInTheDocument();
    expect(screen.queryByText("用户安装的 Pi")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Pi 发行版")).not.toBeInTheDocument();
  });

  it("loads the current Codex CLI catalog instead of presenting only the authored compatibility list", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [
        { id: "default", label: "default: gpt-5.4-mini" },
        { id: "gpt-5.4-mini", label: "GPT-5.4-Mini", supportedReasoningEfforts: ["low", "medium", "high"] },
      ] });
      throw new Error(`unexpected request ${url}`);
    }));

    render(<App />);
    expect(await screen.findByLabelText("Runtime")).toHaveValue("codex");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input) === "/api/models/codex?agent=cli_AgentB2")).toBe(true));
    expect(screen.getByRole("option", { name: "GPT-5.4-Mini" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /GPT-5\.3 Codex/ })).not.toBeInTheDocument();
  });

  it("never flashes authored model choices while the dynamic directory is loading", async () => {
    const directory = deferred<Awaited<ReturnType<typeof ok>>>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return directory.promise;
      throw new Error(`unexpected request ${url}`);
    }));

    render(<App />);
    const model = await screen.findByLabelText("Model");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).startsWith("/api/models/codex"))).toBe(true));
    expect(model).toBeDisabled();
    expect(screen.getByRole("option", { name: "gpt-5.6-sol · 当前配置（模型目录加载中）" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /GPT-5\.3 Codex/ })).not.toBeInTheDocument();

    await act(async () => { directory.resolve(await ok({ models: [{ id: "default", label: "default: gpt-dynamic" }, { id: "gpt-dynamic", label: "Dynamic" }] })); });
    await waitFor(() => expect(model).toBeEnabled());
  });

  it("keeps Model and Effort disabled when the dynamic directory fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return Promise.reject(new Error("catalog offline"));
      throw new Error(`unexpected request ${url}`);
    }));

    render(<App />);
    expect(await screen.findByText(/codex 模型列表暂时不可用/)).toBeVisible();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    expect(screen.getByLabelText("Effort")).toBeDisabled();
    expect(screen.getByRole("option", { name: "gpt-5.6-sol · 当前配置（模型目录不可用）" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /GPT-5\.3 Codex/ })).not.toBeInTheDocument();
  });

  it("loads Claude control-channel models and its locally resolved default", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/claude") return ok({ models: [
        { id: "default", label: "default: claude-opus-4-8[1m]" },
        { id: "sonnet", label: "Sonnet", supportedReasoningEfforts: ["low", "medium", "high"] },
      ] });
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default: gpt-5.6-sol" }] });
      throw new Error(`unexpected request ${url}`);
    }));

    render(<App />);
    await userEvent.selectOptions(await screen.findByLabelText("Runtime"), "claude");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) =>
      String(input) === "/api/models/claude?agent=cli_AgentB2")).toBe(true));
    expect(screen.getByRole("option", { name: "default: claude-opus-4-8[1m]" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Sonnet" })).toBeVisible();
    expect(screen.getByLabelText("Effort")).toBeDisabled();
    expect(within(screen.getByLabelText("Effort")).queryByRole("option", { name: "high" })).not.toBeInTheDocument();
  });

  it("projects reminder lifecycle classes and marks completed reminders as done", async () => {
    const prior = agents[1].remindersList;
    agents[1].remindersList = [
      { title: "等待执行提醒", status: "scheduled", fireAt: "2026-07-25T10:00:00.000Z" },
      { title: "重复等待提醒", status: "scheduled", repeat: "daily", fireAt: "2026-07-26T10:00:00.000Z" },
      { title: "旧版等待提醒", status: "pending", fireAt: "2026-07-25T11:00:00.000Z" },
      { title: "已触发提醒", status: "fired", fireAt: "2026-07-24T09:00:00.000Z" },
      { title: "已取消提醒", status: "canceled", fireAt: "2026-07-24T08:00:00.000Z" },
      { title: "失败提醒", status: "failed", fireAt: "2026-07-24T07:00:00.000Z" },
    ];
    try {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      await userEvent.click(screen.getByRole("tab", { name: "动态" }));
      const scheduled = screen.getByText("等待执行提醒").closest("article");
      const repeated = screen.getByText("重复等待提醒").closest("article");
      const pending = screen.getByText("旧版等待提醒").closest("article");
      const fired = screen.getByText("已触发提醒").closest("article");
      const cancelled = screen.getByText("已取消提醒").closest("article");
      const failed = screen.getByText("失败提醒").closest("article");
      expect(scheduled).toHaveClass("status-scheduled");
      expect(scheduled).not.toHaveClass("done");
      expect(repeated).toHaveClass("status-scheduled");
      expect(repeated).not.toHaveClass("done");
      expect(pending).toHaveClass("status-pending");
      expect(pending).not.toHaveClass("done");
      expect(fired).toHaveClass("status-fired", "done");
      expect(cancelled).toHaveClass("status-canceled", "done");
      expect(failed).toHaveClass("status-failed");
      expect(failed).not.toHaveClass("done");
    } finally { agents[1].remindersList = prior; }
  });

  it("maps timeline categories to semantic dot classes", async () => {
    const prior = agents[1].feed;
    agents[1].feed = [
      { kind: "activity", state: "working", detail: "正在执行语义", at: "2026-07-24T10:03:00.000Z" },
      { kind: "activity", state: "thinking", detail: "正在思考语义", at: "2026-07-24T10:02:59.000Z" },
      { kind: "activity", state: "tool", detail: "工具执行语义", at: "2026-07-24T10:02:58.000Z" },
      { kind: "activity", state: "idle", detail: "空闲语义", at: "2026-07-24T10:02:00.000Z" },
      { kind: "activity", state: "online", detail: "在线语义", at: "2026-07-24T10:01:59.000Z" },
      { kind: "activity", state: "mystery", detail: "未知语义", at: "2026-07-24T10:01:58.000Z" },
      { kind: "deliver", from: "Timeline Sender", target: "#timeline", detail: "投递语义", at: "2026-07-24T10:01:30.000Z" },
      { kind: "error", state: "error", text: "错误语义", at: "2026-07-24T10:01:00.000Z" },
    ];
    try {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      await userEvent.click(screen.getByRole("tab", { name: "高级" }));
      await userEvent.click(screen.getByText("运行日志"));
      const activePanel = screen.getByRole("tabpanel");
      const dotFor = (detail: string) => within(activePanel).getByText(detail).closest("li")?.querySelector(".timeline-dot");
      expect(dotFor("正在执行语义")).toHaveClass("state-active");
      expect(dotFor("正在思考语义")).toHaveClass("state-active");
      expect(dotFor("工具执行语义")).toHaveClass("state-active");
      expect(dotFor("空闲语义")).toHaveClass("state-idle");
      expect(dotFor("在线语义")).toHaveClass("state-idle");
      expect(dotFor("未知语义")).toHaveClass("state-unknown");
      expect(dotFor("投递语义")).toHaveClass("state-deliver");
      expect(dotFor("错误语义")).toHaveClass("state-error");
    } finally { agents[1].feed = prior; }
  });

  it("folds workspace files and logs under 高级 until they are opened", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    expect(document.querySelector(".workspace-browser")).not.toBeVisible();
    await userEvent.click(screen.getByText("工作区文件"));
    await screen.findByText("未选择文件");
    expect(document.querySelector(".workspace-browser")).toBeVisible();
    expect(screen.getByText("运行日志").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText("运行摘要")).toBeNull();
  });

  it("flags a stuck Agent in its header instead of a buried summary", async () => {
    const prior = agents[1].eyeIndicator;
    agents[1].eyeIndicator = { pendingCount: 2, oldestAgeSec: 600 as unknown as null, stuck: true };
    try {
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      expect(screen.getByText("疑似卡住：有消息超过 3 分钟没处理")).toBeVisible();
    } finally { agents[1].eyeIndicator = prior; }
  });

  it("edits a workspace text file with an explicit save and surfaces a concurrent-edit conflict", async () => {
    const original = { kind: "file", path: "AGENTS.md", name: "AGENTS.md", size: 10, modifiedAt: "2026-10-24T10:00:00.000Z",
      binary: false, truncated: false, content: "old rules\n", sha256: "a".repeat(64) };
    const writes: Array<Record<string, unknown>> = [];
    let conflict = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      if (url.pathname === "/api/workspace/file" && init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        if (conflict) return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: "文件已被修改，请重新加载后再编辑" }) });
        const body = JSON.parse(String(init.body));
        return ok({ ...original, content: body.content, sha256: "b".repeat(64) });
      }
      if (url.pathname === "/api/workspace" && url.searchParams.get("path") === "AGENTS.md") return ok(original);
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [
        { name: "AGENTS.md", path: "AGENTS.md", kind: "file", size: 10, modifiedAt: "2026-10-24T10:00:00.000Z" },
      ] });
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "高级" }));
    await userEvent.click(screen.getByText("工作区文件"));
    await userEvent.click(await screen.findByRole("button", { name: /AGENTS\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    const editor = screen.getByLabelText("编辑 AGENTS.md");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await userEvent.clear(editor);
    await userEvent.type(editor, "new rules");
    expect(screen.getByLabelText("未保存")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("下一次开启新会话"));
    expect(writes).toEqual([{ agentId: "cli_AgentB2", path: "AGENTS.md", content: "new rules", expectedSha256: "a".repeat(64) }]);
    expect(screen.queryByLabelText("编辑 AGENTS.md")).not.toBeInTheDocument();

    conflict = true;
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByLabelText("编辑 AGENTS.md"), "!");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已被 Agent 或其他人修改"));
    expect(writes[1]).toMatchObject({ content: "new rules!", expectedSha256: "b".repeat(64) });
    expect(screen.getByLabelText("编辑 AGENTS.md")).toHaveValue("new rules!");
    expect(screen.getByRole("button", { name: "载入最新版本" })).toBeVisible();
  });

  it("creates AGENTS.md from a template in 设定 and adds a CLAUDE.md that imports it", async () => {
    let rules = missingRules();
    const creates: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/models/codex") return ok({ models: [{ id: "default", label: "default" }] });
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
      if (url.pathname === "/api/agent-rules/file" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        creates.push(body);
        rules = { files: rules.files.map((view) => view.name === body.name ? { ...view, file: ruleFile(body.name, body.content) } : view) } as typeof rules;
        return ok(ruleFile(body.name, body.content));
      }
      if (url.pathname === "/api/agent-rules") return ok(rules);
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "设定" }));
    await userEvent.click(await screen.findByRole("button", { name: "用模板新建" }));
    await waitFor(() => expect(creates.map((body) => body.name)).toEqual(["AGENTS.md", "CLAUDE.md"]));
    expect(creates[0]).toMatchObject({ agentId: "cli_AgentB2", content: expect.stringContaining("# 角色") });
    expect(creates[1]).toEqual({ agentId: "cli_AgentB2", name: "CLAUDE.md", content: "@AGENTS.md\n" });
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("编辑 AGENTS.md")).toHaveValue(creates[0].content);
  });

  it("tells a Claude-runtime Agent when CLAUDE.md does not use AGENTS.md", async () => {
    const prior = agents[1].runtime;
    agents[1].runtime = "claude";
    let rules = { files: [
      { name: "AGENTS.md", linkedTo: null, file: ruleFile("AGENTS.md", "# 角色\n"), error: null },
      { name: "CLAUDE.md", linkedTo: null, file: null, error: null },
    ] } as ReturnType<typeof missingRules>;
    const creates: Array<Record<string, unknown>> = [];
    try {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/status") return ok(status);
        if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
        if (url.pathname.startsWith("/api/models/")) return ok({ models: [{ id: "default", label: "default" }] });
        if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
        if (url.pathname === "/api/agent-rules/file" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          creates.push(body);
          rules = { files: rules.files.map((view) => view.name === body.name ? { ...view, file: ruleFile(body.name, body.content) } : view) } as typeof rules;
          return ok(ruleFile(body.name, body.content));
        }
        if (url.pathname === "/api/agent-rules") return ok(rules);
        throw new Error(`unexpected request ${url}`);
      }));
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      await userEvent.click(screen.getByRole("tab", { name: "设定" }));
      expect(await screen.findByText(/还没有 CLAUDE\.md，这份设定不会被读取/)).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "新建 CLAUDE.md 并引用 AGENTS.md" }));
      await waitFor(() => expect(creates).toEqual([{ agentId: "cli_AgentB2", name: "CLAUDE.md", content: "@AGENTS.md\n" }]));
      await waitFor(() => expect(screen.queryByText(/这份设定不会被读取/)).not.toBeInTheDocument());
    } finally { agents[1].runtime = prior; }
  });

  it("lists capabilities by source in 设定 and says when the runtime lacks a kind", async () => {
    const capabilities: Record<string, unknown> = {
      cli_AgentB2: { runtime: "codex", unsupported: [], items: [
        { kind: "skill", source: "global", name: "lark-im", description: "收发飞书消息", location: "~/.agents/skills/lark-im/SKILL.md", status: "ok", detail: null },
        { kind: "skill", source: "workspace", name: "weekly-report", description: "整理周报", location: ".agents/skills/weekly-report/SKILL.md", status: "ok", detail: null },
        { kind: "skill", source: "global", name: "notes", description: null, location: "~/.agents/skills/notes/SKILL.md", status: "invalid", detail: "缺少 description" },
        { kind: "mcp", source: "global", name: "feishu-docs", description: "stdio · npx", location: "~/.codex/config.toml", status: "ok", detail: null },
      ] },
      cli_AgentA1: { runtime: "pi", unsupported: ["subagent", "plugin", "mcp"], items: [] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname.startsWith("/api/models/")) return ok({ models: [{ id: "default", label: "default" }] });
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
      if (url.pathname === "/api/agent-rules") return ok(missingRules());
      if (url.pathname === "/api/agent-capabilities") return ok(capabilities[url.searchParams.get("agent") || ""]);
      throw new Error(`unexpected request ${url}`);
    }));
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=persona");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(await screen.findByRole("button", { name: /^Skill\s*3$/ }));
    const groups = screen.getAllByRole("region").filter((region) => ["工作区", "全局"].includes(region.getAttribute("aria-label") || ""));
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["工作区", "全局"]);
    expect(within(groups[0]).getByText("weekly-report")).toBeVisible();
    expect(within(screen.getByRole("complementary", { name: "weekly-report 详情" })).getByText("只属于这个 Agent，改动从下一个新会话生效。")).toBeVisible();
    await userEvent.click(within(groups[1]).getByRole("button", { name: /notes/ }));
    const detail = screen.getByRole("complementary", { name: "notes 详情" });
    expect(within(detail).getByText("需要修复")).toBeVisible();
    expect(within(detail).getByText("缺少 description")).toBeVisible();
    expect(within(detail).getByText("~/.agents/skills/notes/SKILL.md")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^MCP\s*1$/ }));
    expect(within(screen.getByRole("complementary", { name: "feishu-docs 详情" })).getByText("stdio · npx")).toBeVisible();

    cleanup();
    window.history.replaceState(null, "", "/?agent=cli_AgentA1&tab=persona");
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "研究员" });
    await userEvent.click(await screen.findByRole("button", { name: "Subagent" }));
    expect(screen.getByText("pi 不支持 Subagent")).toBeVisible();
  });

  it("shows the read-only built-in instructions next to AGENTS.md in 设定", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname.startsWith("/api/models/")) return ok({ models: [{ id: "default", label: "default" }] });
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
      if (url.pathname === "/api/agent-rules") return ok(missingRules());
      if (url.pathname === "/api/agent-capabilities") return ok({ runtime: "codex", items: [], unsupported: [] });
      if (url.pathname === "/api/agent-standing-prompt") {
        expect(url.searchParams.get("agent")).toBe("cli_AgentB2");
        return ok({ runtime: "codex", replyMode: "card", version: "larkin-standing-v36-card", content: "# Larkin standing instructions\n\nYou are Builder." });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(await screen.findByRole("button", { name: "内置指令" }));
    const content = await screen.findByRole("region", { name: "内置指令内容" });
    expect(content).toHaveTextContent("You are Builder.");
    expect(screen.getByText("larkin-standing-v36-card")).toBeVisible();
    expect(screen.getByText("卡片回复")).toBeVisible();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("does not render Provider Credentials and keeps only three runtime options", async () => {
    window.history.replaceState(null, "", "/?agent=cli_AgentC3&tab=configuration");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/status") return ok(status);
      if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
      if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
      if (url.pathname === "/api/models/pi" || url.pathname === "/api/models/codex" || url.pathname === "/api/models/claude") {
        return ok({ models: [{ id: "default", label: "default" }, { id: "deepseek/deepseek-v4-pro", label: "DeepSeek" }] });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Pi Agent" });
    expect(screen.queryByRole("heading", { level: 3, name: "Provider Credentials" })).not.toBeInTheDocument();
    expect(screen.queryByText(/pi-auth|pi-distribution|bundled Pi|auth\.json/i)).not.toBeInTheDocument();
    const runtimeSelect = await screen.findByLabelText("Runtime");
    expect([...runtimeSelect.querySelectorAll("option")].map((option) => option.getAttribute("value"))).toEqual(["codex", "claude", "pi"]);
  });

  it("renders readiness, with version and executable, next to the model settings and shows a rejected runtime-switch error", async () => {
    const missing = {
      runtime: "claude" as const,
      state: "missing" as const,
      reason: "claude is not installed",
      nextAction: "Install Claude Code and ensure `claude` is on PATH, or set LARKIN_CLAUDE_COMMAND.",
    };
    const prior = agents[1].runtimeReadiness;
    agents[1].runtimeReadiness = {
      runtime: "codex",
      state: "unauthenticated",
      reason: "codex is installed but not logged in",
      nextAction: "Run `codex login`, then retry.",
      version: "0.130.0",
      executable: "codex",
    };
    try {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/status") return ok(status);
        if (url.pathname === "/api/config" && init?.method === "PATCH") {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ error: missing.reason, readiness: missing }),
          });
        }
        if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
        if (url.pathname === "/api/models/codex" || url.pathname === "/api/models/claude") {
          return ok({ models: [{ id: "default", label: "default: claude" }] });
        }
        throw new Error(`unexpected request ${url}`);
      }));
      render(<App />);
      await screen.findByRole("heading", { level: 1, name: "Builder" });
      expect(await screen.findByText(/^Readiness unauthenticated · codex is installed but not logged in · Run `codex login`/)).toBeVisible();
      expect(screen.getByText(/Run `codex login`, then retry\. · 0\.130\.0 · codex$/)).toBeVisible();
      await userEvent.click(screen.getByRole("tab", { name: "设定" }));
      await userEvent.selectOptions(await screen.findByLabelText("Runtime"), "claude");
      await userEvent.click(screen.getByRole("button", { name: "保存并应用" }));
      const feedback = await screen.findByRole("status");
      expect(feedback).toHaveTextContent(/claude is not installed/);
      expect(feedback).toHaveTextContent(/Install Claude Code/);
    } finally { agents[1].runtimeReadiness = prior; }
  });
});
