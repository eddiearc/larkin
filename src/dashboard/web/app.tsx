import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Bell, Bot, Check, ChevronRight, CircleDot, Clock3, File, Folder,
  Gauge, Logs, Menu, MessageSquareText, RefreshCw, Search, Settings2, SlidersHorizontal, Users, XCircle,
} from "lucide-react";
import { AGENT_TABS, createLatestResponseGate, filterAgents, parseRoute, reconcileAgentId, routeSearch, sameDraft, type AgentTab } from "./dashboard-state";
import type { ConfigAgent, ConfigResponse, DashboardAgent, RuntimeModel, RuntimeReadinessView, StatusResponse, WorkspaceProjection } from "./types";
import { Badge, Button, EmptyState, Sheet, cn } from "./components/ui";

const TAB_LABELS: Record<AgentTab, string> = {
  overview: "概览", conversation: "对话", configuration: "配置", reminders: "提醒", workspace: "工作区", logs: "日志",
};

const bootstrap = window.__LARKIN_DASHBOARD__ || {
  packageVersion: "dev", dashboardVersion: "dev", buildFingerprint: "", csrfCapability: "",
};

class JsonResponseError extends Error {
  constructor(message: string, readonly body: { error?: string; readiness?: RuntimeReadinessView }) { super(message); }
}

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; readiness?: RuntimeReadinessView };
    throw new JsonResponseError(body.error || `HTTP ${response.status}`, body);
  }
  return response.json() as Promise<T>;
}

function readinessFailure(error: unknown, fallback: string): string {
  if (!(error instanceof JsonResponseError) || !error.body.readiness) return error instanceof Error ? error.message : fallback;
  const readiness = error.body.readiness;
  return [readiness.reason || error.message, readiness.nextAction ? `下一步：${readiness.nextAction}` : null]
    .filter(Boolean).join("；");
}

async function mutateConfig(body: Record<string, unknown>): Promise<{ revision: string; applyState: string }> {
  return jsonFetch("/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Larkin-CSRF": bootstrap.csrfCapability },
    body: JSON.stringify(body),
  });
}

function privateGet<T>(url: string, init: RequestInit = {}): Promise<T> {
  return jsonFetch<T>(url, {
    ...init,
    headers: { ...init.headers, "X-Larkin-CSRF": bootstrap.csrfCapability },
  });
}

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "暂无";
  if (seconds < 60) return `${seconds}s 前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m 前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h 前`;
  return `${Math.floor(seconds / 86400)}d 前`;
}

function formatDate(value: unknown): string {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "未知时间";
}

function formatNumber(value: unknown): string {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US") : "—";
}

function activityLabel(agent: DashboardAgent): string {
  if (agent.issue) return "异常";
  if (agent.lastActivity?.state) return String(agent.lastActivity.state);
  return agent.running ? "空闲" : "离线";
}

export function useStatusPolling() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const gate = useRef(createLatestResponseGate());
  const timer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const token = gate.current.issue();
    try {
      const next = await jsonFetch<StatusResponse>("/api/status", { signal: controller.signal });
      if (!gate.current.accepts(token)) return;
      if (bootstrap.buildFingerprint && next.buildFingerprint && next.buildFingerprint !== bootstrap.buildFingerprint) {
        window.location.reload();
        return;
      }
      setData(next);
      setError(null);
      setStale(false);
    } catch (reason) {
      if (controller.signal.aborted || !gate.current.accepts(token)) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setStale(true);
    } finally {
      if (gate.current.accepts(token)) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const cycle = async () => {
      await load();
      if (active) timer.current = window.setTimeout(cycle, 3000);
    };
    void cycle();
    return () => {
      active = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      abort.current?.abort();
    };
  }, [load]);
  return { data, error, loading, stale, retry: load };
}

function AgentAvatar({ agent }: { agent: DashboardAgent }) {
  const initials = (agent.displayName || agent.name || agent.agentId).slice(0, 2).toUpperCase();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [agent.agentId, agent.bot?.hasAvatar]);
  const showImage = agent.bot?.hasAvatar && !failed;
  return <span className="agent-avatar" aria-hidden="true">
    {showImage
      ? <img src={`/api/avatar/${encodeURIComponent(agent.agentId)}`} alt="" onError={() => setFailed(true)} />
      : initials}
  </span>;
}

function AgentSidebar({ agents, selectedId, onSelect, compact = false }: {
  agents: DashboardAgent[];
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterAgents(agents, query), [agents, query]);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (index: number, delta: number) => {
    if (!visible.length) return;
    const next = delta === 0 ? index : (index + delta + visible.length) % visible.length;
    buttons.current[next]?.focus();
  };
  return <div className={cn("sidebar-inner", compact && "compact-sidebar")}>
    <label className="agent-search">
      <Search size={15} aria-hidden="true" />
      <span className="sr-only">搜索 Agent</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Agent…" />
    </label>
    <div className="agent-list" role="listbox" aria-label="Agent 列表">
      {visible.map((agent, index) => <button
        key={agent.agentId}
        ref={(node) => { buttons.current[index] = node; }}
        type="button"
        role="option"
        aria-selected={agent.agentId === selectedId}
        className={cn("agent-list-item", agent.agentId === selectedId && "selected")}
        onClick={() => onSelect(agent.agentId)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(index, 1); }
          if (event.key === "ArrowUp") { event.preventDefault(); move(index, -1); }
          if (event.key === "Home") { event.preventDefault(); move(0, 0); }
          if (event.key === "End") { event.preventDefault(); move(visible.length - 1, 0); }
        }}
      >
        <AgentAvatar agent={agent} />
        <span className="agent-list-copy">
          <strong>{agent.displayName || agent.name}</strong>
          <small>{agent.runtime} · {agent.model}{agent.runtimeReadiness ? ` · ${agent.runtimeReadiness.state}` : ""}</small>
          <span className="status-line"><CircleDot size={10} /> {agent.connection.state} · {activityLabel(agent)}</span>
        </span>
        {agent.issue ? <AlertTriangle size={15} className="danger" aria-label="异常" /> : <ChevronRight size={15} aria-hidden="true" />}
      </button>)}
      {!visible.length ? <EmptyState title="没有匹配的 Agent" detail="可按名称或 App ID 搜索" /> : null}
    </div>
  </div>;
}

function GlobalSettingsSheet({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void }) {
  const [serverValue, setServerValue] = useState<"require" | "free">("require");
  const [draft, setDraft] = useState<"require" | "free">("require");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const dirty = draft !== serverValue;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    void privateGet<ConfigResponse>("/api/config", { signal: controller.signal }).then((value) => {
      setServerValue(value.mentionPolicy);
      setDraft(value.mentionPolicy);
      setFeedback(null);
    }).catch((error) => { if (!controller.signal.aborted) setFeedback(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);
  const requestOpenChange = (next: boolean) => {
    if (!next && dirty && !window.confirm("全局设置尚未保存，确定放弃草稿吗？")) return;
    onOpenChange(next);
  };
  const save = async () => {
    setLoading(true);
    try {
      const result = await mutateConfig({ operation: "set-global-mention", value: draft });
      setServerValue(draft);
      setFeedback(`已保存 · ${result.applyState} · ${result.revision.slice(0, 20)}…`);
      onSaved();
    } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  return <Sheet open={open} onOpenChange={requestOpenChange} title="全局设置" description="只管理所有 Agent 共同继承的默认值；高级操作仍使用 CLI。">
    <div className="settings-form">
      <label><span>真人群消息默认策略</span>
        <select value={draft} onChange={(event) => setDraft(event.target.value as "require" | "free")} disabled={loading}>
          <option value="require">require · 群内需要 @</option>
          <option value="free">free · 群内无需 @</option>
        </select>
      </label>
      <p className="field-help">未单独设置的 Agent 和群会使用这个值。机器人消息仍必须精确 @ 当前 Agent。</p>
      <div className="form-actions"><Button onClick={() => setDraft(serverValue)} disabled={!dirty || loading}>放弃草稿</Button><Button className="primary" onClick={save} disabled={!dirty || loading}>{loading ? "保存中…" : "保存全局设置"}</Button></div>
      {feedback ? <p role="status" className="feedback">{feedback}</p> : null}
    </div>
  </Sheet>;
}

function GroupPolicyTable({ config, onSave, disabled }: {
  config: ConfigAgent;
  onSave: (chatId: string, value: "inherit" | "require" | "free") => Promise<void>;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [newChat, setNewChat] = useState("");
  const [newPolicy, setNewPolicy] = useState<"require" | "free">("require");
  const groups = config.knownChats.filter((chat) => chat.kind === "group" && chat.override !== "inherit").filter((chat) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || chat.chatId.toLocaleLowerCase().includes(needle) || String(chat.displayName || "未解析群名").toLocaleLowerCase().includes(needle);
  });
  return <section className="group-policy-section" aria-labelledby="group-policy-title">
    <div className="section-heading"><div><h3 id="group-policy-title">群策略</h3><p>这里只显示为当前 Agent 单独设置过消息策略的群。</p></div><label className="table-search"><Search size={14} /><span className="sr-only">搜索群</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群名或 chat_id" /></label></div>
    <div className="policy-table-wrap">
      <table className="policy-table"><thead><tr><th>群</th><th>消息策略</th><th>操作</th></tr></thead>
        <tbody>{groups.map((chat) => <tr key={chat.chatId}>
          <td><strong>{chat.displayName || chat.chatId}</strong>{chat.displayName ? <code>{chat.chatId}</code> : <small>群名暂时不可用</small>}</td>
          <td><select aria-label={`${chat.displayName || chat.chatId} 消息策略`} value={chat.override} disabled={disabled} onChange={(event) => void onSave(chat.chatId, event.target.value as "require" | "free")}><option value="require">需要 @</option><option value="free">无需 @</option></select></td>
          <td><Button disabled={disabled} onClick={() => void onSave(chat.chatId, "inherit")}>移除特别配置</Button></td>
        </tr>)}</tbody></table>
      {!groups.length ? <EmptyState title={query ? "没有匹配的群" : "还没有单独配置的群"} detail="新增后，Larkin 会自动解析并缓存群名。" /> : null}
    </div>
    <div className="chat-add"><label><span>完整 chat_id</span><input value={newChat} onChange={(event) => setNewChat(event.target.value)} placeholder="oc_QAConfigChat1" /></label><label><span>消息策略</span><select value={newPolicy} onChange={(event) => setNewPolicy(event.target.value as typeof newPolicy)}><option value="require">需要 @</option><option value="free">无需 @</option></select></label><Button disabled={disabled || !/^oc_[A-Za-z0-9_-]+$/.test(newChat)} onClick={() => void onSave(newChat, newPolicy).then(() => setNewChat(""))}>保存群策略</Button></div>
  </section>;
}

function AgentConfiguration({ agentId, onDirtyChange, refreshKey }: { agentId: string; onDirtyChange: (dirty: boolean) => void; refreshKey: number }) {
  const [response, setResponse] = useState<ConfigResponse | null>(null);
  const [serverDraft, setServerDraft] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [modelDirectory, setModelDirectory] = useState<{
    runtime: string;
    status: "loading" | "ready" | "error";
    models: RuntimeModel[];
  } | null>(null);
  const gate = useRef(createLatestResponseGate());
  const modelDirectoryGate = useRef(createLatestResponseGate());
  const dirty = !sameDraft(serverDraft, draft);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const load = useCallback(async (preserveDraft = false) => {
    const token = gate.current.issue();
    setLoading(true);
    try {
      const next = await privateGet<ConfigResponse>(`/api/config?agent=${encodeURIComponent(agentId)}`);
      if (!gate.current.accepts(token)) return;
      const agent = next.agents[0];
      if (!agent) throw new Error("配置投影中没有当前 Agent");
      const values = { runtime: agent.runtime, model: agent.model, effort: agent.effort || "default", mention: agent.mention.override };
      setResponse(next);
      setServerDraft(values);
      if (!preserveDraft || !dirty) setDraft(values);
    } catch (error) { if (gate.current.accepts(token)) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (gate.current.accepts(token)) setLoading(false); }
  }, [agentId, dirty]);
  useEffect(() => { void load(false); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshKey > 0) void load(true); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const config = response?.agents[0];
  const update = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  const runtime = String(draft.runtime || config?.runtime || "");
  const model = String(draft.model || config?.model || "default");
  useEffect(() => {
    setModelDirectory({ runtime, status: "loading", models: [] });
    if (!new Set(["pi", "codex", "claude"]).has(runtime)) {
      setModelDirectory({ runtime, status: "error", models: [] });
      return;
    }
    const token = modelDirectoryGate.current.issue();
    const controller = new AbortController();
    void privateGet<{ models: RuntimeModel[] }>(`/api/models/${runtime}?agent=${encodeURIComponent(agentId)}`, { signal: controller.signal })
      .then((value) => { if (modelDirectoryGate.current.accepts(token)) setModelDirectory({ runtime, status: "ready", models: value.models }); })
      .catch((error) => {
        if (!controller.signal.aborted && modelDirectoryGate.current.accepts(token)) {
          setModelDirectory({ runtime, status: "error", models: [] });
          setFeedback(`${runtime} 模型列表暂时不可用：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return () => controller.abort();
  }, [agentId, runtime]);
  const directoryReady = modelDirectory?.runtime === runtime && modelDirectory.status === "ready";
  const directoryStatus = modelDirectory?.runtime === runtime ? modelDirectory.status : "loading";
  const models = directoryReady ? modelDirectory.models : [];
  const unavailableLabel = `${model} · 当前配置（模型目录${directoryStatus === "error" ? "不可用" : "加载中"}）`;
  const visibleModels = directoryReady
    ? (models.some((item) => item.id === model) ? models : [{ id: model, label: `${model} · 当前配置` }, ...models])
    : [{ id: model, label: unavailableLabel }];
  const efforts = directoryReady && model !== "default" ? models.find((item) => item.id === model)?.supportedReasoningEfforts || [] : [];
  const runtimeDirty = draft.runtime !== serverDraft.runtime || draft.model !== serverDraft.model || draft.effort !== serverDraft.effort;

  const requestApply = () => jsonFetch<{ agentId: string; applyState: string }>("/api/config/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Larkin-CSRF": bootstrap.csrfCapability },
    body: JSON.stringify({ agentId }),
  });

  const save = async () => {
    if (!config) return;
    setLoading(true);
    try {
      const operations: Array<Record<string, unknown>> = [];
      if (draft.runtime !== serverDraft.runtime) operations.push({ operation: "set-agent-runtime", agentId, runtime: draft.runtime, model: draft.model });
      else if (draft.model !== serverDraft.model) operations.push({ operation: "set-agent-model", agentId, model: draft.model });
      if (draft.effort !== serverDraft.effort) operations.push({ operation: "set-agent-effort", agentId, effort: draft.effort });
      if (draft.mention !== serverDraft.mention) operations.push({ operation: "set-agent-mention", agentId, value: draft.mention });
      let latest: { revision: string; applyState: string } | null = null;
      for (const operation of operations) latest = await mutateConfig(operation);
      if (runtimeDirty) {
        try {
          await requestApply();
          setFeedback("配置已保存并应用");
        } catch (error) {
          setFeedback(`配置已保存但未应用：${readinessFailure(error, "稍后重试")}`);
        }
      } else {
        setFeedback(latest ? "配置已保存" : "没有需要保存的修改");
      }
      await load(false);
    } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const apply = async () => {
    setLoading(true);
    try {
      await requestApply();
      setFeedback("已应用保存的运行配置");
      await load(true);
    } catch (error) { setFeedback(`配置保持已保存但未应用：${readinessFailure(error, "稍后重试")}`); }
    finally { setLoading(false); }
  };
  const saveChat = async (chatId: string, value: "inherit" | "require" | "free") => {
    setLoading(true);
    try {
      const result = await mutateConfig({ operation: "set-chat-mention", agentId, chatId, value });
      setFeedback(`群策略已保存 · ${result.applyState}`);
      await load(true);
    } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  if (!config && loading) return <EmptyState title="加载 Agent 配置…" />;
  if (!config) return <EmptyState title="配置不可用" detail={feedback || "请重试"} />;
  const applyStateLabel = config.apply.applyState === "pending" ? "待应用" : config.apply.applyState === "applied" ? "已应用" : "状态未知";
  return <div className="configuration-page">
    <section className="config-section"><div className="section-heading"><div><h3>Agent 配置</h3><p>只作用于 {agentId}；运行配置会在安全时机自动应用，Agent 正忙时会保留待处理。</p></div><Badge className={config.apply.applyState === "pending" ? "warning" : "success"}>{applyStateLabel}</Badge></div>
      <p className="cli-guidance">这里只提供常用微调。更多配置可以直接告诉当前 Agent，让它运行 <code>larkin config --help</code> 后完成。</p>
      <div className="config-grid">
        <label><span>Runtime</span><select value={runtime} disabled={loading} onChange={(event) => { update("runtime", event.target.value); update("model", "default"); update("effort", "default"); }}>{Object.keys(response?.runtimeModels || {}).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Model</span><select value={model} disabled={loading || !directoryReady} onChange={(event) => { update("model", event.target.value); if (event.target.value === "default") update("effort", "default"); }}>{visibleModels.map((item) => <option value={item.id} key={item.id}>{item.label || item.id}</option>)}</select></label>
        <label><span>Effort</span><select value={String(draft.effort || "default")} disabled={loading || !directoryReady || model === "default" || !efforts.length} onChange={(event) => update("effort", event.target.value)}><option value="default">default · 不指定</option>{efforts.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>群消息策略</span><select value={String(draft.mention || "inherit")} disabled={loading} onChange={(event) => update("mention", event.target.value)}><option value="inherit">跟随全局设置</option><option value="require">需要 @</option><option value="free">无需 @</option></select></label>
      </div>
      {dirty || config.apply.applyState === "pending" ? <div className="form-actions">
        {dirty ? <Button disabled={loading} onClick={() => setDraft(serverDraft)}>放弃草稿</Button> : null}
        {dirty
          ? <Button className="primary" disabled={loading} onClick={save}>{loading ? "处理中…" : runtimeDirty ? "保存并应用" : "保存 Agent 配置"}</Button>
          : <Button className="primary" disabled={loading} onClick={apply}><RefreshCw size={14} /> 应用已保存配置</Button>}
      </div> : null}
      {feedback ? <p role="status" className="feedback">{feedback}</p> : null}
    </section>
    <GroupPolicyTable config={config} onSave={saveChat} disabled={loading} />
  </div>;
}

function Overview({ agent }: { agent: DashboardAgent }) {
  const usage = agent.session?.usage || {};
  const compaction = agent.session?.compaction || {};
  return <div className="overview-page">
    <div className="metrics-band" aria-label="Agent 运行指标">
      <section className="metric-stat"><div className="metric-icon"><CircleDot /></div><span>连接</span><strong>{agent.connection.state}</strong><small>{agent.connection.reason}</small></section>
      <section className="metric-stat"><div className="metric-icon"><Activity /></div><span>执行状态</span><strong>{activityLabel(agent)}</strong><small>{agent.lastActivity ? formatAge(agent.lastActivity.ageSec) : "尚无活动"}</small></section>
      <section className="metric-stat"><div className="metric-icon"><MessageSquareText /></div><span>最近消息</span><strong>{agent.lastDeliver?.from || "暂无"}</strong><small>{agent.lastDeliver ? `${agent.lastDeliver.target || ""} · ${formatAge(agent.lastDeliver.ageSec)}` : "尚无消息记录"}</small></section>
      <section className="metric-stat"><div className="metric-icon"><Gauge /></div><span>上下文</span><strong>{usage.contextPercent != null ? `${Math.round(Number(usage.contextPercent))}%` : `${agent.session?.turns || 0} turns`}</strong><small>{agent.session ? `session ${agent.session.id.slice(0, 12)}…` : "尚未建立 session"}</small></section>
      <section className="metric-stat"><div className="metric-icon"><Gauge /></div><span>累计 Token</span><strong>{formatNumber(usage.cumulativeTokens)}</strong><small>{usage.available ? "完整 session 累计" : usage.reason || "暂无用量"}</small></section>
      <section className="metric-stat"><div className="metric-icon"><Activity /></div><span>最近一轮用量</span><strong>{formatNumber(usage.latestTokens)}</strong><small>输入、缓存与输出合计</small></section>
      <section className="metric-stat"><div className="metric-icon"><RefreshCw /></div><span>Compaction</span><strong>{formatNumber(compaction.count)}</strong><small>{compaction.active ? "正在压缩上下文" : compaction.lastFinishedAt ? `最近 ${formatDate(compaction.lastFinishedAt)}` : "尚无压缩记录"}</small></section>
    </div>
    <div className="overview-sections">
      <section className="content-section wide"><div className="section-heading"><div><h3>最近动态</h3><p>当前 Agent 的消息、工具和状态转换。</p></div><Badge>{agent.feed.length}</Badge></div><Timeline items={agent.feed.slice(0, 10)} /></section>
      <section className="content-section"><h3>运行摘要</h3><dl className="facts"><div><dt>Runtime</dt><dd>{agent.runtime}</dd></div><div><dt>Readiness</dt><dd>{agent.runtimeReadiness ? `${agent.runtimeReadiness.state}${agent.runtimeReadiness.version ? ` · ${agent.runtimeReadiness.version}` : ""}${agent.runtimeReadiness.executable ? ` · ${agent.runtimeReadiness.executable}` : ""}${agent.runtimeReadiness.reason ? ` · ${agent.runtimeReadiness.reason}` : ""}${agent.runtimeReadiness.nextAction ? ` · ${agent.runtimeReadiness.nextAction}` : ""}` : "unknown"}</dd></div><div><dt>Model</dt><dd>{agent.model}</dd></div><div><dt>Effort</dt><dd>{agent.effort || "default"}</dd></div><div><dt>入站</dt><dd>{agent.inbound.state}</dd></div><div><dt>提醒</dt><dd>{agent.activeReminders}</dd></div><div><dt>指示灯</dt><dd>{agent.eyeIndicator.stuck ? "疑似卡住" : `${agent.eyeIndicator.pendingCount} pending`}</dd></div></dl></section>
    </div>
  </div>;
}

function Timeline({ items }: { items: DashboardAgent["feed"] }) {
  if (!items.length) return <EmptyState title="还没有活动记录" />;
  const stateClass = (item: DashboardAgent["feed"][number]) => {
    if (item.kind === "error" || item.state === "error") return "state-error";
    if (item.kind === "deliver") return "state-deliver";
    if (["working", "thinking", "tool"].includes(String(item.state))) return "state-active";
    if (["idle", "online"].includes(String(item.state))) return "state-idle";
    return "state-unknown";
  };
  return <ol className="timeline">{items.map((item, index) => <li key={`${item.at}-${index}`}><span className={cn("timeline-dot", stateClass(item))} /><div><strong>{item.kind === "deliver" ? "收到消息" : item.kind === "error" ? "错误" : item.state || "活动"}</strong><p>{item.text || item.detail || [item.from, item.target].filter(Boolean).join(" → ") || item.tool || "状态已更新"}</p><time>{formatDate(item.at)}</time></div></li>)}</ol>;
}

function Conversation({ agent }: { agent: DashboardAgent }) {
  if (!agent.conversation.length) return <EmptyState title="还没有对话摘录" detail="Host 更新本地 conversation projection 后会显示在这里。" />;
  return <div className="conversation-list">{agent.conversation.map((row, index) => {
    const state = row.direction === "out" ? "已发送" : row.wake ? "入站 · 已唤醒" : "旁听 · 未唤醒";
    return <article key={`${row.at}-${index}`} className={cn("conversation-item", row.direction === "out" ? "outbound" : "inbound", row.direction === "in" && !row.wake && "listening")}>
      <header><div><Badge className={row.direction === "in" && !row.wake ? "warning" : row.direction === "out" ? "accent" : "success"}>{state}</Badge><strong>{row.from || (row.direction === "out" ? agent.displayName : "未知发送者")}</strong></div><time>{formatDate(row.at)}</time></header>
      <p>{row.text || "[非文本消息]"}</p>{row.target ? <small>{row.target}</small> : null}
    </article>;
  })}</div>;
}

function Reminders({ agent }: { agent: DashboardAgent }) {
  if (!agent.remindersList.length) return <EmptyState title="还没有提醒" />;
  const labels: Record<string, string> = { scheduled: "待执行", pending: "待执行", fired: "已完成", canceled: "已取消", cancelled: "已取消", failed: "失败" };
  return <div className="reminder-list">{agent.remindersList.map((reminder, index) => {
    const status = reminder.status || "scheduled";
    const done = ["fired", "canceled", "cancelled"].includes(status);
    const styleStatus = status === "cancelled" ? "canceled" : status;
    return <article key={`${reminder.fireAt}-${index}`} className={cn(`status-${styleStatus}`, done && "done")}><Bell size={16} /><div><strong>{reminder.title || "未命名提醒"}</strong><p>{formatDate(reminder.fireAt)}{reminder.repeat ? " · 重复" : ""}</p></div><Badge className={["scheduled", "pending"].includes(status) ? "warning" : status === "fired" ? "success" : status === "failed" ? "danger-badge" : ""}>{labels[status] || status}</Badge></article>;
  })}</div>;
}

function Workspace({ agentId }: { agentId: string }) {
  const [directory, setDirectory] = useState<Extract<WorkspaceProjection, { kind: "directory" }> | null>(null);
  const [file, setFile] = useState<Extract<WorkspaceProjection, { kind: "file" }> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestResponseGate());
  const load = useCallback(async (requestedPath: string) => {
    const token = gate.current.issue();
    setLoading(true);
    try {
      const value = await jsonFetch<WorkspaceProjection>(`/api/workspace?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(requestedPath)}`);
      if (!gate.current.accepts(token)) return;
      if (value.kind === "directory") { setDirectory(value); setFile(null); }
      else setFile(value);
      setError(null);
    } catch (reason) { if (gate.current.accepts(token)) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (gate.current.accepts(token)) setLoading(false); }
  }, [agentId]);
  useEffect(() => { void load(""); }, [load]);
  const parts = directory?.path.split("/").filter(Boolean) || [];
  return <div className="workspace-browser">
    <div className="workspace-side"><nav className="breadcrumbs" aria-label="工作区路径"><button onClick={() => void load("")}>workspace</button>{parts.map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={12} /><button onClick={() => void load(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav><div className="workspace-list" role="region" aria-label="工作区目录">{directory?.entries.map((entry) => <button key={entry.path} onClick={() => void load(entry.path)}>{entry.kind === "directory" ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span><small>{entry.kind === "file" ? `${entry.size} B` : "目录"}</small></button>)}{!loading && directory && !directory.entries.length ? <EmptyState title="空目录" /> : null}</div></div>
    <div className="workspace-preview" role="region" aria-label="文件预览">{loading ? <EmptyState title="读取工作区…" /> : error ? <EmptyState title="工作区读取失败" detail={error} /> : file ? <><header><strong>{file.name}</strong><small>{file.truncated ? "仅预览前 1 MB" : `${file.size} B`}</small></header>{file.binary ? <EmptyState title="二进制文件不可预览" /> : <pre>{file.content}</pre>}</> : <EmptyState title="只读工作区" detail="选择文件进行预览" />}</div>
  </div>;
}

function LogsPanel({ agent }: { agent: DashboardAgent }) {
  return <section className="logs-section"><div className="section-heading"><div><h3>结构化日志</h3><p>最近 30 条本地状态投影；不暴露原始日志文件或路径。</p></div><Badge>{agent.feed.length}</Badge></div><Timeline items={agent.feed} />{agent.recentErrors.length ? <section className="error-stack"><h4>最近错误</h4>{agent.recentErrors.map((error, index) => <div key={`${error.at}-${index}`}><XCircle size={14} /><span>{error.text || error.message || "未知错误"}</span><time>{formatDate(error.at)}</time></div>)}</section> : null}</section>;
}

function AgentHeader({ agent }: { agent: DashboardAgent }) {
  const usage = agent.session?.usage || {};
  const compaction = agent.session?.compaction || {};
  const context = usage.contextPercent != null
    ? `上下文 ${Math.round(Number(usage.contextPercent))}% · ${formatNumber(usage.latestTokens)} / ${formatNumber(usage.contextWindow)}`
    : `上下文 ${agent.session?.turns || 0} turns`;
  return <header className="agent-header"><div className="agent-title"><AgentAvatar agent={agent} /><div><p>{agent.agentId}</p><h1>{agent.displayName || agent.name}</h1></div></div><div className="agent-header-summary"><Badge className={agent.connection.state === "connected" ? "success" : agent.issue ? "danger-badge" : ""}>{agent.connection.state}</Badge><span>{agent.runtime}</span><span>{agent.model}</span><span>{agent.effort || "default effort"}</span><span>{context}</span><span>累计 {formatNumber(usage.cumulativeTokens)} tokens</span><span>最近一轮 {formatNumber(usage.latestTokens)} tokens</span><span>Compact {formatNumber(compaction.count)} 次 · {compaction.active ? "active" : "idle"}</span><span>最近消息 {agent.lastDeliver ? formatAge(agent.lastDeliver.ageSec) : "暂无"}</span><span>{agent.lastActivity?.detail || activityLabel(agent)}</span></div></header>;
}

export function App() {
  const polling = useStatusPolling();
  const initial = useMemo(() => parseRoute(window.location.search), []);
  const [selectedId, setSelectedId] = useState<string | null>(initial.agentId);
  const [tab, setTab] = useState<AgentTab>(initial.tab);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const [agentDirty, setAgentDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const agents = polling.data?.agents || [];
  const packageVersion = polling.data?.packageVersion || bootstrap.packageVersion;
  const selected = agents.find((agent) => agent.agentId === selectedId) || null;
  const saveScroll = useCallback((agentId: string, agentTab: AgentTab) => {
    const key = `${agentId}:${agentTab}`;
    const value = window.scrollY;
    scrollPositions.current.set(key, value);
    try { sessionStorage.setItem(`larkin-dashboard-scroll:${key}`, String(value)); } catch { /* best effort */ }
  }, []);
  const savedScroll = useCallback((key: string) => {
    if (scrollPositions.current.has(key)) return scrollPositions.current.get(key) || 0;
    try {
      const value = Number(sessionStorage.getItem(`larkin-dashboard-scroll:${key}`));
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch { return 0; }
  }, []);

  const writeRoute = useCallback((agentId: string | null, nextTab: AgentTab, replace = false) => {
    if (selectedId) saveScroll(selectedId, tab);
    const method = replace ? "replaceState" : "pushState";
    window.history[method](null, "", routeSearch(agentId, nextTab));
    setSelectedId(agentId);
    setTab(nextTab);
  }, [saveScroll, selectedId, tab]);
  const allowContextChange = () => !agentDirty || window.confirm("Agent 配置尚未保存，确定放弃草稿吗？");
  const selectAgent = (agentId: string) => {
    if (!allowContextChange()) return;
    setAgentDirty(false);
    writeRoute(agentId, tab);
    setMobileOpen(false);
  };
  const selectTab = (next: AgentTab) => {
    if (next !== "configuration" && !allowContextChange()) return;
    if (next !== "configuration") setAgentDirty(false);
    writeRoute(selectedId, next);
  };

  useEffect(() => {
    if (!polling.data) return;
    const next = reconcileAgentId(selectedId, polling.data.agents);
    if (next !== selectedId) {
      setNotice(selectedId ? "原 Agent 已不存在，已切换到第一个可用 Agent。" : null);
      writeRoute(next, tab, true);
    }
  }, [polling.data, selectedId, tab, writeRoute]);
  useEffect(() => {
    const pop = () => {
      const next = parseRoute(window.location.search);
      if (agentDirty && !window.confirm("Agent 配置尚未保存，确定离开吗？")) {
        window.history.pushState(null, "", routeSearch(selectedId, tab));
        return;
      }
      if (selectedId) saveScroll(selectedId, tab);
      setAgentDirty(false);
      setSelectedId(next.agentId);
      setTab(next.tab);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [agentDirty, saveScroll, selectedId, tab]);
  useLayoutEffect(() => {
    if (!selectedId) return;
    const key = `${selectedId}:${tab}`;
    const top = savedScroll(key);
    if (window.scrollY !== top) window.scrollTo({ top, behavior: "auto" });
  }, [savedScroll, selectedId, tab]);

  return <div className={cn("app-shell", tab === "workspace" && "workspace-app-active")}>
    <aside className="desktop-sidebar"><div className="brand"><img src="/assets/larkin-mark.svg" alt="" /><strong>Larkin <span className="brand-version">v{packageVersion}</span></strong></div><AgentSidebar agents={agents} selectedId={selectedId} onSelect={selectAgent} /><footer>{polling.data?.daemon.running ? `${agents.length} Agents · daemon online` : "daemon offline"}</footer></aside>
    <main className={cn("workspace-shell", tab === "workspace" && "workspace-route-active")}>
      <div className="app-topbar"><Button className="mobile-menu" aria-label="打开 Agent 导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></Button><div><strong>Larkin <span className="brand-version">v{packageVersion}</span></strong><span>{polling.data?.daemon.running ? "运行中" : "未运行"}</span>{polling.stale ? <Badge className="warning">状态陈旧</Badge> : null}</div><Button onClick={() => setGlobalOpen(true)}><Settings2 size={15} /> 全局设置</Button></div>
      {polling.error ? <div className="stale-banner" role="alert"><AlertTriangle size={15} />状态刷新失败，保留最后一次数据：{polling.error}<Button onClick={() => void polling.retry()}>重试</Button></div> : null}
      {notice ? <div className="notice" role="status">{notice}<Button aria-label="关闭提示" onClick={() => setNotice(null)}>×</Button></div> : null}
      {polling.loading && !polling.data ? <div className="page-loading"><RefreshCw className="spin" />加载 Agent 工作台…</div> : !selected ? <EmptyState title="还没有配置任何 Agent" detail="先运行 larkin setup。" /> : <>
        <AgentHeader agent={selected} />
        <nav className="agent-tabs" aria-label={`${selected.displayName} 内容页签`} role="tablist">{AGENT_TABS.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>{item === "overview" ? <Gauge /> : item === "conversation" ? <MessageSquareText /> : item === "configuration" ? <SlidersHorizontal /> : item === "reminders" ? <Bell /> : item === "workspace" ? <Folder /> : <Logs />}{TAB_LABELS[item]}</button>)}</nav>
        <div className={cn("agent-content", tab === "workspace" && "workspace-active")} key={selected.agentId}>
          <section role="tabpanel" hidden={tab !== "overview"}><Overview agent={selected} /></section>
          <section role="tabpanel" hidden={tab !== "conversation"}><Conversation agent={selected} /></section>
          <section role="tabpanel" hidden={tab !== "configuration"}><AgentConfiguration agentId={selected.agentId} onDirtyChange={setAgentDirty} refreshKey={configRefreshKey} /></section>
          <section role="tabpanel" hidden={tab !== "reminders"}><Reminders agent={selected} /></section>
          <section className="workspace-tab-panel" role="tabpanel" hidden={tab !== "workspace"}><Workspace agentId={selected.agentId} /></section>
          <section role="tabpanel" hidden={tab !== "logs"}><LogsPanel agent={selected} /></section>
        </div>
      </>}
    </main>
    <GlobalSettingsSheet open={globalOpen} onOpenChange={setGlobalOpen} onSaved={() => setConfigRefreshKey((value) => value + 1)} />
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="选择 Agent" description="搜索、查看状态并切换当前工作区。"><AgentSidebar compact agents={agents} selectedId={selectedId} onSelect={selectAgent} /></Sheet>
  </div>;
}
