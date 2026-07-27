import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, useStatusPolling } from "../../src/dashboard/web/app";

const agents = [
  {
    agentId: "cli_AgentA1", name: "cli_AgentA1", displayName: "研究员", runtime: "pi", model: "default", effort: null,
    running: true, issue: false, credentialReady: true, bot: null,
    connection: { state: "connected", reason: "current channel" }, inbound: { state: "pending", reason: "waiting" },
    lastActivity: { state: "working", detail: "整理资料", ageSec: 8 }, lastDeliver: { from: "idan", target: "#research", ageSec: 12 },
    eyeIndicator: { pendingCount: 0, oldestAgeSec: null, stuck: false }, activeReminders: 1,
    remindersList: [{ title: "同步进度", status: "pending", fireAt: "2026-07-24T12:00:00.000Z" }],
    session: null, conversation: [], feed: [], recentErrors: [], knownChats: 0,
  },
  {
    agentId: "cli_AgentB2", name: "cli_AgentB2", displayName: "Builder", runtime: "codex", model: "gpt-5.6-sol", effort: "high",
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
];

const status = {
  version: "0.2.20+test", packageVersion: "0.2.20", buildFingerprint: "sha256:test", generatedAt: "2026-07-24T10:00:00.000Z",
  daemon: { running: true, state: "owned", reason: null, uptimeSec: 100, agents: agents.map((agent) => agent.agentId) }, agents,
};

const config = (agentId?: string) => ({
  version: 4, mentionPolicy: "free", persistedRevision: "sha256:revision",
  runtimeModels: {
    codex: [{ id: "default" }, { id: "gpt-5.6-sol", supportedReasoningEfforts: ["low", "high"] }],
    claude: [{ id: "default" }], pi: [{ id: "default" }],
  },
  agents: (agentId ? agents.filter((agent) => agent.agentId === agentId) : agents).map((agent) => ({
    agentId: agent.agentId, runtime: agent.runtime, model: agent.model, effort: agent.effort,
    mention: { override: agent.agentId === "cli_AgentB2" ? "require" : "inherit", effective: agent.agentId === "cli_AgentB2" ? "require" : "free", source: agent.agentId === "cli_AgentB2" ? "agent" : "global" },
    knownChats: agent.agentId === "cli_AgentB2" ? [
      { chatId: "oc_BuildRoom", displayName: "构建群", kind: "group", override: "free", effective: "free", source: "chat" },
      { chatId: "oc_InheritedRoom", displayName: "继承群", kind: "group", override: "inherit", effective: "require", source: "agent" },
    ] : [],
    apply: { applyState: "pending" },
  })),
});

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
  window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=configuration");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/status") return ok(status);
    if (url.pathname === "/api/config") return ok(config(url.searchParams.get("agent") || undefined));
    if (url.pathname === "/api/workspace") return ok({ kind: "directory", path: "", parent: null, entries: [] });
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
    window.history.replaceState(null, "", "/?agent=cli_AgentB2&tab=configuration");
    const { container } = render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    expect(screen.getAllByText("v0.2.20")).toHaveLength(2);
    expect(container.querySelector(".app-topbar strong")).toHaveTextContent(/^Larkin v0\.2\.20$/);
    expect(screen.getByRole("tab", { name: "配置" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Agent workbench")).not.toBeInTheDocument();
    const guidance = await screen.findByText(/这里只提供常用微调/);
    expect(guidance).toBeVisible();
    expect(guidance).toHaveTextContent(/当前 Agent.*larkin config --help/);
  });

  it("renders only explicit group policies without implementation-oriented precedence terminology", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Builder" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "配置" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { level: 3, name: "群策略" })).toBeVisible();
    expect(screen.getByText("构建群")).toBeVisible();
    expect(screen.queryByText("继承群")).not.toBeInTheDocument();
    expect(screen.queryByText(/覆盖链/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/effective/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/override/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("搜索群名或 chat_id"), "missing");
    expect(screen.getByText("没有匹配的群")).toBeVisible();
  });

  it("separates global settings and protects an Agent draft before navigation", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("button", { name: "全局设置" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByRole("heading", { name: "全局设置" })).toBeVisible();
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "关闭面板" }));

    const runtime = await screen.findByLabelText("Runtime");
    await userEvent.selectOptions(runtime, "claude");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await userEvent.click(screen.getByRole("option", { name: /研究员/ }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Builder" })).toBeVisible();
    expect(window.location.search).toContain("agent=cli_AgentB2");
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
    await userEvent.click(screen.getByRole("tab", { name: "对话" }));
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
    await userEvent.click(screen.getByRole("tab", { name: "概览" }));
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
    await userEvent.click(screen.getByRole("tab", { name: "对话" }));
    await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" }));
    scrollY = 88;
    await userEvent.click(screen.getByRole("tab", { name: "配置" }));
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
    expect(result.current.error).toBe("poll offline");
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
      await userEvent.click(screen.getByRole("tab", { name: "提醒" }));
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
      await userEvent.click(screen.getByRole("tab", { name: "日志" }));
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

  it("marks the active workspace route so the workspace can fill the remaining viewport", async () => {
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Builder" });
    await userEvent.click(screen.getByRole("tab", { name: "工作区" }));
    await screen.findByText("只读工作区");
    expect(document.querySelector(".agent-content")).toHaveClass("workspace-active");
    expect(document.querySelector(".workspace-browser")).toBeVisible();
  });
});
