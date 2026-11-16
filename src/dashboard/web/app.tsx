import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Bell, Bot, Check, ChevronRight, CircleDot, Clock3, File, Folder,
  Gauge, Menu, MessageSquareText, RefreshCw, ScrollText, Search, SlidersHorizontal, Users, XCircle,
} from "lucide-react";
import { AGENT_TABS, createLatestResponseGate, filterAgents, parseRoute, reconcileAgentId, routeSearch, sameDraft, type AgentTab } from "./dashboard-state";
import type { CapabilitiesResponse, CapabilityKind, ConfigAgent, ConfigResponse, DashboardAgent, InstructionFilesResponse, RuntimeModel, RuntimeReadinessView, StandingPromptResponse, StatusResponse, WorkspaceProjection } from "./types";
import { Badge, Button, EmptyState, Sheet, cn } from "./components/ui";
import { MENTION_POLICY_OPTIONS } from "./mention-policy";
import { RUNTIME_OPTIONS } from "../../runtime/user-runtime.js";

const TAB_LABELS: Record<AgentTab, string> = {
  activity: "动态", persona: "设定", reply: "回复规则", advanced: "高级",
};

const bootstrap = window.__LARKIN_DASHBOARD__ || {
  packageVersion: "dev", dashboardVersion: "dev", buildFingerprint: "", csrfCapability: "",
};

const UNREACHABLE = "连不上 larkin：服务可能已停止或正在重启。确认 larkin 在运行后刷新页面。";

class JsonResponseError extends Error {
  constructor(message: string, readonly body: { error?: string; readiness?: RuntimeReadinessView }) { super(message); }
}

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { cache: "no-store", ...init }); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; readiness?: RuntimeReadinessView };
    throw new JsonResponseError(body.error || `请求失败（HTTP ${response.status}）`, body);
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

const MIN_AUDIT_GAP_MINUTES = 1;
const MAX_AUDIT_GAP_MINUTES = 24 * 60;

function formatAuditGapMinutes(intervalMs: number): string {
  return String(intervalMs / 60_000);
}

function auditGapFromMinutes(value: unknown): number | null {
  const minutes = Number(String(value).trim());
  const candidateMs = minutes * 60_000;
  const intervalMs = Math.round(candidateMs);
  return Number.isFinite(minutes) && minutes >= MIN_AUDIT_GAP_MINUTES && minutes <= MAX_AUDIT_GAP_MINUTES
    && Number.isSafeInteger(intervalMs) && Math.abs(candidateMs - intervalMs) <= 0.000_001 ? intervalMs : null;
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

function GroupPolicyTable({ config, onSave, disabled }: {
  config: ConfigAgent;
  onSave: (chatId: string, value: "inherit" | "require" | "free") => Promise<void>;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [newChat, setNewChat] = useState("");
  const [newPolicy, setNewPolicy] = useState<"require" | "free">("require");
  const groups = (config.knownChats ?? []).filter((chat) => chat.kind === "group" && chat.override !== "inherit").filter((chat) => {
    const needle = query.trim().toLocaleLowerCase();
    return !needle || chat.chatId.toLocaleLowerCase().includes(needle) || String(chat.displayName || "未解析群名").toLocaleLowerCase().includes(needle);
  });
  return <section className="group-policy-section" aria-labelledby="group-policy-title">
    <div className="section-heading"><div><h3 id="group-policy-title">单独设置的群</h3><p>个别群想和上面「群消息」不一样时，在这里添加。</p></div><label className="table-search"><Search size={14} /><span className="sr-only">搜索群</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索群名或 chat_id" /></label></div>
    <div className="policy-table-wrap">
      <table className="policy-table"><thead><tr><th>群</th><th>消息策略</th><th>操作</th></tr></thead>
        <tbody>{groups.map((chat) => <tr key={chat.chatId}>
          <td><strong>{chat.displayName || chat.chatId}</strong>{chat.displayName ? <code>{chat.chatId}</code> : <small>群名暂时不可用</small>}</td>
          <td><select aria-label={`${chat.displayName || chat.chatId} 消息策略`} value={chat.override} disabled={disabled} onChange={(event) => void onSave(chat.chatId, event.target.value as "require" | "free")}><option value="require">{MENTION_POLICY_OPTIONS.require.title}</option><option value="free">{MENTION_POLICY_OPTIONS.free.title}</option></select></td>
          <td><Button disabled={disabled} onClick={() => void onSave(chat.chatId, "inherit")}>移除特别配置</Button></td>
        </tr>)}</tbody></table>
      {!groups.length ? <EmptyState title={query ? "没有匹配的群" : "还没有单独配置的群"} detail="在下面填群的 chat_id 添加；群名会自动查出来。" /> : null}
    </div>
    <div className="chat-add"><label><span>完整 chat_id</span><input value={newChat} onChange={(event) => setNewChat(event.target.value)} placeholder="oc_QAConfigChat1" /></label><label><span>消息策略</span><select value={newPolicy} onChange={(event) => setNewPolicy(event.target.value as typeof newPolicy)}><option value="require">{MENTION_POLICY_OPTIONS.require.title}</option><option value="free">{MENTION_POLICY_OPTIONS.free.title}</option></select></label><Button disabled={disabled || !/^oc_[A-Za-z0-9_-]+$/.test(newChat)} onClick={() => void onSave(newChat, newPolicy).then(() => setNewChat(""))}>保存群策略</Button></div>
  </section>;
}

function formatReadiness(readiness: RuntimeReadinessView): string {
  return [
    `Readiness ${readiness.state}`,
    readiness.reason,
    readiness.nextAction,
    readiness.version,
    readiness.executable,
  ].filter(Boolean).join(" · ");
}

/** The draft fields each settings page owns. A page loads, compares and saves only these, so saving one
 * page never resubmits another page's stale value. */
const SECTION_FIELDS = {
  model: ["runtime", "model", "effort", "fastMode"],
  reply: ["mention", "replyMode"],
  advanced: ["sandbox", "auditEnabled", "auditGapMinutes"],
} as const;

function AgentConfiguration({ section, agentId, readiness, onDirtyChange, onSaved, refreshKey }: {
  /** Which part of the Agent's settings this instance edits; each saves only the fields it shows. */
  section: "model" | "reply" | "advanced";
  agentId: string;
  readiness: RuntimeReadinessView | null;
  onDirtyChange: (dirty: boolean) => void;
  /** Lets the other half reload, since a save can change the shared apply state. */
  onSaved: () => void;
  refreshKey: number;
}) {
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
      // Only the reply tab lists groups; the other tabs skip the Feishu group-name lookup.
      const next = await privateGet<ConfigResponse>(`/api/config?agent=${encodeURIComponent(agentId)}${section === "reply" ? "" : "&chats=0"}`);
      if (!gate.current.accepts(token)) return;
      const agent = next.agents[0];
      if (!agent) throw new Error("配置投影中没有当前 Agent");
      const all: Record<string, unknown> = {
        runtime: agent.runtimeOption || agent.runtime, model: agent.model, effort: agent.effort || "default", mention: agent.mention.effective, replyMode: agent.replyMode ?? "cli",
        sandbox: agent.sandbox || "danger-full-access", fastMode: agent.fastMode === true,
        auditEnabled: agent.inboxAudit.effective.enabled,
        auditGapMinutes: formatAuditGapMinutes(agent.inboxAudit.effective.intervalMs),
      };
      const values = Object.fromEntries(SECTION_FIELDS[section].map((key) => [key, all[key]]));
      setResponse(next);
      setServerDraft(values);
      if (!preserveDraft || !dirty) setDraft(values);
    } catch (error) { if (gate.current.accepts(token)) setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { if (gate.current.accepts(token)) setLoading(false); }
  }, [agentId, dirty, section]);
  useEffect(() => { void load(false); }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshKey > 0) void load(true); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const config = response?.agents[0];
  const update = (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  const runtime = String(draft.runtime || config?.runtime || "");
  const model = String(draft.model || config?.model || "default");
  useEffect(() => {
    if (section !== "model") return;
    setModelDirectory({ runtime, status: "loading", models: [] });
    if (!(RUNTIME_OPTIONS as readonly string[]).includes(runtime)) {
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
  }, [agentId, runtime, section]);
  const directoryReady = modelDirectory?.runtime === runtime && modelDirectory.status === "ready";
  const directoryStatus = modelDirectory?.runtime === runtime ? modelDirectory.status : "loading";
  const models = directoryReady ? modelDirectory.models : [];
  const unavailableLabel = `${model} · 当前配置（模型目录${directoryStatus === "error" ? "不可用" : "加载中"}）`;
  const visibleModels = directoryReady
    ? (models.some((item) => item.id === model) ? models : [{ id: model, label: `${model} · 当前配置` }, ...models])
    : [{ id: model, label: unavailableLabel }];
  const efforts = directoryReady && model !== "default" ? models.find((item) => item.id === model)?.supportedReasoningEfforts || [] : [];
  const sandboxDirty = draft.sandbox !== serverDraft.sandbox;
  const fastDirty = draft.fastMode !== serverDraft.fastMode;
  // Unknown until the directory loads; only an explicit false from the catalog blocks the switch.
  const fastSupported = runtime === "codex" && !(directoryReady && models.find((item) => item.id === model)?.supportsFast === false);
  // Sandbox is a Codex launch parameter, so it is applied the same way as a model change.
  const replyModeDirty = draft.replyMode !== serverDraft.replyMode;
  const runtimeDirty = draft.runtime !== serverDraft.runtime || draft.model !== serverDraft.model || draft.effort !== serverDraft.effort || sandboxDirty || fastDirty || replyModeDirty;
  const auditEnabled = draft.auditEnabled === true;
  const auditGapMinutes = String(draft.auditGapMinutes || "");
  const auditGapDirty = draft.auditGapMinutes !== serverDraft.auditGapMinutes;
  const auditDirty = draft.auditEnabled !== serverDraft.auditEnabled || auditGapDirty;

  const requestApply = () => jsonFetch<{ agentId: string; applyState: string }>("/api/config/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Larkin-CSRF": bootstrap.csrfCapability },
    body: JSON.stringify({ agentId }),
  });

  const save = async () => {
    if (!config) return;
    const auditIntervalMs = auditGapFromMinutes(draft.auditGapMinutes);
    if (auditGapDirty && auditIntervalMs === null) {
      setFeedback("巡检间隔必须在 1 到 1440 分钟之间；草稿已保留。");
      return;
    }
    setLoading(true);
    try {
      const operations: Array<Record<string, unknown>> = [];
      if (draft.runtime !== serverDraft.runtime) operations.push({ operation: "set-agent-runtime", agentId, runtime: draft.runtime, model: draft.model });
      else if (draft.model !== serverDraft.model) operations.push({ operation: "set-agent-model", agentId, model: draft.model });
      if (draft.effort !== serverDraft.effort) operations.push({ operation: "set-agent-effort", agentId, effort: draft.effort });
      if (fastDirty) operations.push({ operation: "set-agent-fast-mode", agentId, value: draft.fastMode === true });
      if (sandboxDirty) operations.push({ operation: "set-agent-sandbox", agentId, value: draft.sandbox });
      if (replyModeDirty) operations.push({ operation: "set-agent-reply-mode", agentId, value: draft.replyMode });
      if (draft.mention !== serverDraft.mention) operations.push({ operation: "set-agent-mention", agentId, value: draft.mention });
      if (auditDirty) operations.push({
        operation: "set-agent-inbox-audit", agentId,
        ...(draft.auditEnabled !== serverDraft.auditEnabled ? { enabled: auditEnabled } : {}),
        ...(auditGapDirty ? { intervalMs: auditIntervalMs! } : {}),
      });
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
      onSaved();
    } catch (error) { setFeedback(readinessFailure(error, error instanceof Error ? error.message : String(error))); }
    finally { setLoading(false); }
  };
  const apply = async () => {
    setLoading(true);
    try {
      await requestApply();
      setFeedback("已应用保存的运行配置");
      await load(true);
      onSaved();
    } catch (error) { setFeedback(`配置保持已保存但未应用：${readinessFailure(error, "稍后重试")}`); }
    finally { setLoading(false); }
  };
  const saveChat = async (chatId: string, value: "inherit" | "require" | "free") => {
    setLoading(true);
    try {
      const result = await mutateConfig({ operation: "set-chat-mention", agentId, chatId, value });
      setFeedback(`群策略已保存 · ${result.applyState}`);
      await load(true);
      onSaved();
    } catch (error) { setFeedback(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };

  if (!config && loading) return <EmptyState title="加载 Agent 配置…" />;
  if (!config) return <EmptyState title="配置不可用" detail={feedback || "请重试"} />;
  const applyStateLabel = config.apply.applyState === "pending" ? "待应用" : config.apply.applyState === "applied" ? "已应用" : "状态未知";
  const actions = dirty || (section === "model" && config.apply.applyState === "pending") ? <div className="form-actions">
    {dirty ? <Button disabled={loading} onClick={() => setDraft(serverDraft)}>放弃草稿</Button> : null}
    {dirty
      ? <Button className="primary" disabled={loading} onClick={save}>{loading ? "处理中…" : runtimeDirty ? "保存并应用" : "保存 Agent 配置"}</Button>
      : <Button className="primary" disabled={loading} onClick={apply}><RefreshCw size={14} /> 应用已保存配置</Button>}
  </div> : null;
  const status = feedback ? <p role="status" className="feedback">{feedback}</p> : null;
  if (section === "reply") {
    const choiceCards = (name: string, label: string, choices: Array<{ value: string; title: string; detail: string }>) =>
      <div className="sandbox-options" role="radiogroup" aria-label={label}>
        {choices.map((choice) => {
          const checked = draft[name] === choice.value;
          return <label key={choice.value} className={cn("sandbox-option", checked && "active")}>
            <input type="radio" name={`${name}-${agentId}`} value={choice.value} checked={checked} disabled={loading} onChange={() => update(name, choice.value)} />
            <span className="sandbox-option-text"><strong>{choice.title}</strong><span /><small>{choice.detail}</small></span>
          </label>;
        })}
      </div>;
    return <div className="configuration-page">
    <section className="config-section"><div className="section-heading"><div><h3>群消息</h3><p>没 @ 它的群消息，它看不看。私聊和 @ 它的消息总会回复；其他机器人的消息只有准确 @ 它才回。</p></div></div>
      {choiceCards("mention", "群消息策略", (["require", "free"] as const).map((value) => ({ value, ...MENTION_POLICY_OPTIONS[value] })))}
    </section>
    <section className="config-section"><div className="section-heading"><div><h3>回复方式</h3><p>回复以什么形式出现。保存后 Agent 会重新加载，对话上下文不丢；正忙时等它空下来再切换。</p></div></div>
      {choiceCards("replyMode", "回复方式", REPLY_MODE_OPTIONS)}
      {actions}{status}
    </section>
    <GroupPolicyTable config={config} onSave={saveChat} disabled={loading} />
  </div>;
  }
  if (section === "advanced") return <div className="configuration-page">
    <section className="config-section">
      <div className="audit-controls" aria-labelledby="agent-sandbox-title">
        <div className="audit-heading"><div><h3 id="agent-sandbox-title">沙箱</h3><p>决定 Agent 能改动你电脑上的哪些文件。它干活时不会停下来问你，所以边界要在这里先定好。</p></div></div>
        <div className="sandbox-options" role="radiogroup" aria-label="沙箱模式">
          {SANDBOX_OPTIONS.map((option) => {
            const checked = (draft.sandbox || "danger-full-access") === option.value;
            return <label key={option.value} className={cn("sandbox-option", checked && "active")}>
              <input type="radio" name={`sandbox-${agentId}`} value={option.value} checked={checked} disabled={loading} onChange={() => update("sandbox", option.value)} />
              <span className="sandbox-option-text"><strong>{option.title}</strong><Badge>{option.tag}</Badge><small>{option.detail}</small></span>
            </label>;
          })}
        </div>
        {runtime === "codex" ? <details className="sandbox-scope">
          <summary>选「只改自己的工作区」后，具体能改哪些地方</summary>
          <ul>
            <li>它的工作区 <code>~/.larkin/agents/{agentId}/</code>，AGENTS.md 也在这里</li>
            <li>它的消息、提醒和飞书登录记录 <code>~/.larkin/state/agents/{agentId}/</code></li>
            <li>临时文件夹，比如 <code>/tmp</code></li>
          </ul>
          <p>其余位置都只能看、不能改。因此它也改不了 Larkin 的设置，Inbox 巡检会无法标记完成。</p>
        </details> : <p className="field-help">只对 Codex 生效。当前是 {runtime}，这项保存了也不会改变它的行为。</p>}
        <p className="field-help">保存后自动应用；Agent 正忙时会等它空下来再切换。</p>
      </div>
      {sandboxDirty ? <>{actions}{status}</> : null}
    </section>
    <section className="config-section">
      <div className="audit-controls" aria-labelledby="agent-inbox-audit-title">
        <div className="audit-heading"><div><h3 id="agent-inbox-audit-title">Inbox 巡检</h3><p>防止群里的消息漏回。有人在群里找过它之后，它会隔一段时间回到那个群或话题看一眼，把漏掉的补上。</p></div><label className="audit-switch"><input aria-label="Inbox 巡检开关" type="checkbox" checked={auditEnabled} disabled={loading} onChange={(event) => update("auditEnabled", event.target.checked)} /><span aria-hidden="true" /><b>{auditEnabled ? "已开启" : "已关闭"}</b></label></div>
        <div className="config-grid audit-grid">
          <label><span>巡检间隔（分钟）</span><input aria-label="巡检间隔（分钟）" type="number" min={MIN_AUDIT_GAP_MINUTES} max={MAX_AUDIT_GAP_MINUTES} step="any" inputMode="decimal" value={auditGapMinutes} disabled={loading} onChange={(event) => update("auditGapMinutes", event.target.value)} /></label>
        </div>
        <p className="audit-now" role="note">{auditEnabled
          ? `现在：有人在群里找过它之后，约 ${auditGapMinutes || "?"} 分钟内回头检查一次。没人找它就不检查，不花额度。`
          : "现在：已关闭。群里没回上的消息不会被补上。"}</p>
        {draft.sandbox === "workspace-write" && auditEnabled ? <p className="field-help warning-text">这个 Agent 的沙箱是「只改自己的工作区」，巡检做完后标记不了完成，同一个群会被反复检查。</p> : null}
        <details className="sandbox-scope">
          <summary>巡检具体怎么做</summary>
          <ol>
            <li>有人在群里叫到它（@ 它，或在不用 @ 的群里说话），就记下这个群或话题。私聊和没叫过它的群不记。</li>
            <li>每到间隔，如果有记下的群或话题，就开一轮巡检；没有就跳过。</li>
            <li>每个群或话题读最近 20 条消息，找两类问题：有人问了它却没回；它答应会发的结果或要 @ 的人，最后没发出去。</li>
            <li>找到就补发一条回复；没找到就不出声。处理完这个群或话题就不再记着，直到下次有人找它。</li>
          </ol>
          <p>每开一轮巡检就是一次模型调用。群里找它越频繁、间隔越短，花的额度越多。</p>
        </details>
      </div>
      {sandboxDirty ? null : <>{actions}{status}</>}
    </section>
  </div>;
  return <div className="configuration-page">
    <section className="config-section"><div className="section-heading"><div><h3>模型</h3><p>这个 Agent 用哪个 Runtime 和模型。保存后自动应用，Agent 正忙时会等它空下来再切换。</p></div><Badge className={config.apply.applyState === "pending" ? "warning" : "success"}>{applyStateLabel}</Badge></div>
      <p className="cli-guidance">更多选项可以让 Agent 运行 <code>larkin config --help</code> 自己改。</p>
      {readiness ? <p className="field-help">{formatReadiness(readiness)}</p> : null}
      <div className="config-grid">
        <label><span>Runtime</span><select value={runtime} disabled={loading} onChange={(event) => { update("runtime", event.target.value); update("model", "default"); update("effort", "default"); if (event.target.value !== "codex") update("fastMode", false); }}>{(response?.runtimeOptions || RUNTIME_OPTIONS).map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Model</span><select value={model} disabled={loading || !directoryReady} onChange={(event) => { update("model", event.target.value); if (event.target.value === "default") update("effort", "default"); }}>{visibleModels.map((item) => <option value={item.id} key={item.id}>{item.label || item.id}</option>)}</select></label>
        <label><span>Effort</span><select value={String(draft.effort || "default")} disabled={loading || !directoryReady || model === "default" || !efforts.length} onChange={(event) => update("effort", event.target.value)}><option value="default">default · 不指定</option>{efforts.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      </div>
      {runtime === "codex" ? <div className="fast-mode-row"><div><strong>Fast 模式</strong><p className="field-help">{fastSupported ? "回复更快，消耗的用量也更多。关闭时跟随本机 Codex 自己的设置。" : "这个模型不支持 Fast。"}</p></div><label className="audit-switch"><input type="checkbox" aria-label="Fast 模式" checked={draft.fastMode === true} disabled={loading || (!fastSupported && draft.fastMode !== true)} onChange={(event) => update("fastMode", event.target.checked)} /><span aria-hidden="true" /><b>{draft.fastMode === true ? "已开启" : "已关闭"}</b></label></div> : null}
      {actions}{status}
    </section>
  </div>;
}

function ActivityPanel({ agent }: { agent: DashboardAgent }) {
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
      <section className="content-section wide"><div className="section-heading"><div><h3>最近对话</h3><p>谁找了它、它回了什么。</p></div><Badge>{agent.conversation.length}</Badge></div><Conversation agent={agent} /></section>
      <section className="content-section"><div className="section-heading"><div><h3>提醒</h3><p>在聊天里让它记下的提醒。</p></div><Badge>{agent.activeReminders}</Badge></div><Reminders agent={agent} /></section>
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

const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

type WorkspaceFile = Extract<WorkspaceProjection, { kind: "file" }>;

function TextFileEditor({ agentId, file, onSaved, onReload, onDirtyChange }: {
  agentId: string;
  file: WorkspaceFile;
  onSaved: (file: WorkspaceFile) => void;
  onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ tone: "success" | "error"; text: string; conflict?: boolean } | null>(null);
  const dirty = draft !== null && draft !== (file.content ?? "");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => { setDraft(null); }, [file.sha256]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const save = async () => {
    if (draft === null || !file.sha256 || saving) return;
    setSaving(true);
    try {
      const saved = await jsonFetch<WorkspaceProjection>("/api/workspace/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Larkin-CSRF": bootstrap.csrfCapability },
        body: JSON.stringify({ agentId, path: file.path, content: draft, expectedSha256: file.sha256 }),
      });
      setDraft(null);
      setSaveFeedback({ tone: "success", text: INSTRUCTION_FILES.has(file.name)
        ? "已保存。Agent 会在下一次开启新会话时读取这份规则。"
        : "已保存。" });
      if (saved.kind === "file") onSaved(saved);
    } catch (reason) {
      const conflict = reason instanceof JsonResponseError && /已被修改/.test(reason.message);
      setSaveFeedback({ tone: "error", conflict, text: conflict
        ? "保存失败：文件在你编辑期间已被 Agent 或其他人修改。你的草稿还在，可先复制出来，再载入最新版本。"
        : `保存失败：${reason instanceof Error ? reason.message : String(reason)}` });
    } finally { setSaving(false); }
  };
  const editing = draft !== null;
  const editable = Boolean(!file.binary && !file.truncated && file.sha256);
  return <>
    <header>
      <strong>{file.name}{dirty ? <span className="dirty-dot" aria-label="未保存" title="未保存">●</span> : null}</strong>
      <div className="workspace-file-actions">
        <small>{file.truncated ? "仅预览前 1 MB" : `${file.size} B`}</small>
        {editing ? <>
          <Button disabled={saving} onClick={() => { if (!dirty || window.confirm("放弃这次改动？")) { setDraft(null); setSaveFeedback(null); } }}>取消</Button>
          <Button className="primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button>
        </> : editable ? <Button onClick={() => { setDraft(file.content ?? ""); setSaveFeedback(null); }}>编辑</Button> : null}
      </div>
    </header>
    {saveFeedback ? <p role="status" className={cn("workspace-feedback", saveFeedback.tone === "error" && "danger")}>{saveFeedback.text}{saveFeedback.conflict ? <Button onClick={() => { if (window.confirm("载入最新版本会丢弃你的草稿，确定吗？")) { setSaveFeedback(null); onReload(); } }}>载入最新版本</Button> : null}</p> : null}
    {file.binary ? <EmptyState title="二进制文件不可预览" />
      : editing ? <textarea className="workspace-editor" aria-label={`编辑 ${file.name}`} value={draft ?? ""} spellCheck={false} disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} />
      : <pre>{file.content}</pre>}
  </>;
}

function Workspace({ agentId, onDirtyChange }: { agentId: string; onDirtyChange: (dirty: boolean) => void }) {
  const [directory, setDirectory] = useState<Extract<WorkspaceProjection, { kind: "directory" }> | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const gate = useRef(createLatestResponseGate());
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
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
  const open = (requestedPath: string) => {
    if (dirty && !window.confirm("文件改动尚未保存，确定放弃吗？")) return;
    void load(requestedPath);
  };
  const parts = directory?.path.split("/").filter(Boolean) || [];
  return <div className="workspace-browser">
    <div className="workspace-side"><nav className="breadcrumbs" aria-label="工作区路径"><button onClick={() => open("")}>workspace</button>{parts.map((part, index) => <span key={`${part}-${index}`}><ChevronRight size={12} /><button onClick={() => open(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav><div className="workspace-list" role="region" aria-label="工作区目录">{directory?.entries.map((entry) => <button key={entry.path} onClick={() => open(entry.path)}>{entry.kind === "directory" ? <Folder size={15} /> : <File size={15} />}<span>{entry.name}</span><small>{entry.kind === "file" ? `${entry.size} B` : "目录"}</small></button>)}{!loading && directory && !directory.entries.length ? <EmptyState title="空目录" /> : null}</div></div>
    <div className={cn("workspace-preview", dirty && "editing")} role="region" aria-label="文件预览">{loading ? <EmptyState title="读取工作区…" /> : error ? <EmptyState title="工作区读取失败" detail={error} /> : file ? <TextFileEditor key={file.path} agentId={agentId} file={file} onSaved={setFile} onReload={() => void load(file.path)} onDirtyChange={setDirty} /> : <EmptyState title="未选择文件" detail="选择文件进行预览；文本文件可以点「编辑」修改" />}</div>
  </div>;
}

const REPLY_MODE_OPTIONS = [
  { value: "card", title: "流式卡片", detail: "在原消息下发一张卡片，回复实时写进去，能看到思考和每一步操作。机器人需要 cardkit:card:write 权限。" },
  { value: "cli", title: "普通消息", detail: "Agent 想好后自己发一条普通消息。" },
];

const SANDBOX_OPTIONS = [
  { value: "danger-full-access", title: "不限制", tag: "默认", detail: "能改这台电脑上的任何文件，和你自己在终端里用 Codex 一样。适合只有你在用、需要跨项目干活的 Agent。" },
  { value: "workspace-write", title: "只改自己的工作区", tag: "更安全", detail: "其他文件只能看、不能改；联网和收发飞书照常。适合放在群里、很多人都能使唤的 Agent。" },
] as const;

const AGENTS_TEMPLATE = "# 角色\n\n（这个 Agent 是谁，替谁做事）\n\n# 说话方式\n\n（语气、篇幅、要不要用表情）\n\n# 工作习惯\n\n（遇到什么情况怎么做）\n\n# 不要做的事\n\n";
const CLAUDE_IMPORTS_AGENTS = "@AGENTS.md\n";

type InstructionFileView = InstructionFilesResponse["files"][number];

/** CLAUDE.md follows AGENTS.md when it links to it or imports it with an `@AGENTS.md` line. */
function claudeFollowsAgents(view: InstructionFileView | undefined): boolean {
  return view?.linkedTo === "AGENTS.md" || /^@AGENTS\.md\s*$/m.test(view?.file?.content || "");
}

function AgentPersona({ agent, onDirtyChange }: { agent: DashboardAgent; onDirtyChange: (dirty: boolean) => void }) {
  const [data, setData] = useState<InstructionFilesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const gate = useRef(createLatestResponseGate());
  const agentId = agent.agentId;
  const load = useCallback(async () => {
    const token = gate.current.issue();
    try {
      const value = await jsonFetch<InstructionFilesResponse>(`/api/agent-rules?agent=${encodeURIComponent(agentId)}`);
      if (!gate.current.accepts(token)) return;
      setData(value);
      setError(null);
    } catch (reason) { if (gate.current.accepts(token)) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [agentId]);
  useEffect(() => { void load(); }, [load]);
  const agentsView = data?.files.find((view) => view.name === "AGENTS.md");
  const claudeView = data?.files.find((view) => view.name === "CLAUDE.md");
  const createFiles = async (files: Array<{ name: string; content: string }>) => {
    setCreating(true);
    try {
      for (const { name, content } of files) {
        await jsonFetch<WorkspaceProjection>("/api/agent-rules/file", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Larkin-CSRF": bootstrap.csrfCapability },
          body: JSON.stringify({ agentId, name, content }),
        });
      }
    } catch (reason) { setError(`新建失败：${reason instanceof Error ? reason.message : String(reason)}`); }
    finally { setCreating(false); }
    await load();
  };
  // Creating AGENTS.md also adds a CLAUDE.md that imports it, so switching to Claude keeps the same persona.
  const createAgents = (content: string) => void createFiles([
    { name: "AGENTS.md", content },
    ...(claudeView && !claudeView.file && !claudeView.error && !claudeView.linkedTo ? [{ name: "CLAUDE.md", content: CLAUDE_IMPORTS_AGENTS }] : []),
  ]);
  const claudeNote = agent.runtime !== "claude" || !data || claudeFollowsAgents(claudeView) ? null
    : claudeView?.error ? <>CLAUDE.md 读取失败：{claudeView.error}</>
    : claudeView?.file ? <>当前是 Claude runtime，读取的是 CLAUDE.md。它有单独的内容，没有引用 AGENTS.md，可以在「工作区」里编辑。</>
    : agentsView?.file ? <>当前是 Claude runtime，还没有 CLAUDE.md，这份设定不会被读取。<Button disabled={creating} onClick={() => void createFiles([{ name: "CLAUDE.md", content: CLAUDE_IMPORTS_AGENTS }])}>新建 CLAUDE.md 并引用 AGENTS.md</Button></>
    : null;
  const [view, setView] = useState<"agents" | "builtin" | CapabilityKind>("agents");
  // Runtime decides which folders hold the capabilities, so reload them when it changes.
  const capabilities = useCapabilities(agentId, agent.runtime);
  const countOf = (kind: CapabilityKind) => capabilities.data?.items.filter((item) => item.kind === kind).length;
  return <section className="persona-section">
    <div className="persona-switch" role="group" aria-label="设定分类">
      {(["agents", "builtin", ...CAPABILITY_KINDS] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} className={view === item ? "active" : ""} onClick={() => setView(item)}>
        {item === "agents" ? "AGENTS.md" : item === "builtin" ? "内置指令" : CAPABILITY_LABELS[item]}{item !== "agents" && item !== "builtin" && countOf(item) !== undefined && !capabilities.data?.unsupported.includes(item) ? <small>{countOf(item)}</small> : null}
      </button>)}
    </div>
    <div hidden={view !== "agents"}>
      <p className="field-help">新会话开始时读取，改完从下一个新会话生效。Claude 通过 CLAUDE.md 里的 <code>@AGENTS.md</code> 读到它。</p>
      {error ? <p role="alert" className="workspace-feedback danger">{error}</p> : null}
      {claudeNote ? <p className="persona-note">{claudeNote}</p> : null}
      {!data && !error ? <EmptyState title="读取 AGENTS.md…" /> : null}
      {agentsView?.error ? <EmptyState title="AGENTS.md 读取失败" detail={agentsView.error} />
        : agentsView?.file ? <div className="workspace-preview persona-editor"><TextFileEditor agentId={agentId} file={agentsView.file} onSaved={(file) => setData((current) => current && {
          files: current.files.map((entry) => entry.name === "AGENTS.md" ? { ...entry, file } : entry),
        })} onReload={() => void load()} onDirtyChange={onDirtyChange} /></div>
        : agentsView ? <div className="persona-missing">
          <EmptyState title="还没有 AGENTS.md" detail="写下这个 Agent 是谁、怎么说话、遇到什么情况怎么做。可以从模板开始。" />
          <div className="form-actions">
            <Button className="primary" disabled={creating} onClick={() => createAgents(AGENTS_TEMPLATE)}>用模板新建</Button>
            <Button disabled={creating} onClick={() => createAgents("")}>新建空白文件</Button>
          </div>
        </div>
        : null}
    </div>
    {view === "builtin" ? <StandingPromptView agent={agent} /> : null}
    {view !== "agents" && view !== "builtin" ? <CapabilityList agent={agent} kind={view} state={capabilities} /> : null}
  </section>;
}

/** Read-only view of the instructions Larkin adds to every new session; users customize through AGENTS.md instead. */
function StandingPromptView({ agent }: { agent: DashboardAgent }) {
  const [data, setData] = useState<StandingPromptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestResponseGate());
  const agentId = agent.agentId;
  const load = useCallback(async () => {
    const token = gate.current.issue();
    try {
      const value = await jsonFetch<StandingPromptResponse>(`/api/agent-standing-prompt?agent=${encodeURIComponent(agentId)}`);
      if (!gate.current.accepts(token)) return;
      setData(value);
      setError(null);
    } catch (reason) { if (gate.current.accepts(token)) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [agentId]);
  useEffect(() => { void load(); }, [load, agent.runtime]);
  if (error) return <EmptyState title="内置指令读取失败" detail={error} />;
  if (!data) return <EmptyState title="读取内置指令…" />;
  return <div className="standing-prompt">
    <div className="section-heading"><div><p>larkin 每次开新会话时自动加给 Agent 的指令，只读。想补充或调整行为，写进 AGENTS.md，两者会同时生效；尽量不要和这里的规则冲突。</p></div><Button onClick={() => void load()}>刷新</Button></div>
    <div className="capability-detail-badges"><Badge>{data.version}</Badge><Badge>{data.runtime}</Badge><Badge>{data.replyMode === "card" ? "卡片回复" : "命令行回复"}</Badge></div>
    <div className="workspace-preview" role="region" aria-label="内置指令内容"><pre>{data.content}</pre></div>
  </div>;
}

const CAPABILITY_KINDS = ["skill", "subagent", "plugin", "mcp"] as const satisfies readonly CapabilityKind[];
const CAPABILITY_LABELS: Record<CapabilityKind, string> = { skill: "Skill", subagent: "Subagent", plugin: "插件", mcp: "MCP" };
type CapabilityItem = CapabilitiesResponse["items"][number];
const CAPABILITY_SOURCES: Array<{ source: CapabilityItem["source"]; title: string; note: string }> = [
  { source: "workspace", title: "工作区", note: "只属于这个 Agent，改动从下一个新会话生效。" },
  { source: "global", title: "全局", note: "来自本机的全局配置，所有 Agent 和你自己用这个 runtime 时共用，这里只读。" },
  { source: "plugin", title: "插件带的", note: "随插件安装，内容跟着插件更新，这里只读。" },
  { source: "builtin", title: "自带", note: "runtime 自带，不能修改。" },
];
const CAPABILITY_STATUS: Record<CapabilityItem["status"], { label: string; className: string }> = {
  ok: { label: "可用", className: "success" },
  disabled: { label: "已停用", className: "" },
  invalid: { label: "需要修复", className: "warning" },
  shadowed: { label: "被覆盖", className: "" },
};

function useCapabilities(agentId: string, runtime: string) {
  const [data, setData] = useState<CapabilitiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gate = useRef(createLatestResponseGate());
  const load = useCallback(async () => {
    const token = gate.current.issue();
    try {
      const value = await jsonFetch<CapabilitiesResponse>(`/api/agent-capabilities?agent=${encodeURIComponent(agentId)}`);
      if (!gate.current.accepts(token)) return;
      setData(value);
      setError(null);
    } catch (reason) { if (gate.current.accepts(token)) setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [agentId]);
  useEffect(() => { void load(); }, [load, runtime]);
  return { data, error, reload: load };
}

function CapabilityList({ agent, kind, state }: { agent: DashboardAgent; kind: CapabilityKind; state: ReturnType<typeof useCapabilities> }) {
  const items = CAPABILITY_SOURCES.flatMap(({ source }) => (state.data?.items || []).filter((item) => item.kind === kind && item.source === source));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const keyOf = (item: CapabilityItem) => `${item.source}:${item.location}:${item.name}`;
  const selected = items.find((item) => keyOf(item) === selectedKey) || items[0] || null;
  const label = CAPABILITY_LABELS[kind];
  if (state.error) return <EmptyState title={`${label} 读取失败`} detail={state.error} />;
  if (!state.data) return <EmptyState title={`读取 ${label}…`} />;
  if (state.data.unsupported.includes(kind)) return <EmptyState title={`${state.data.runtime} 不支持 ${label}`} detail="切换 runtime 后这里会显示对应的内容。" />;
  return <div className="capability-view">
    <div className="section-heading"><div><p>{agent.displayName || agent.name}（{state.data.runtime}）新会话里能用的 {label}。工作区里的只属于它；全局的所有 Agent 共用，这里只读。</p></div><Button onClick={() => void state.reload()}>刷新</Button></div>
    {!items.length ? <EmptyState title={`还没有 ${label}`} /> : <div className="capability-layout">
      <div className="capability-groups">{CAPABILITY_SOURCES.map(({ source, title }) => {
        const group = items.filter((item) => item.source === source);
        if (!group.length) return null;
        return <section key={source} aria-label={title}>
          <h4>{title}</h4>
          <div className="capability-rows">{group.map((item) => {
            const status = CAPABILITY_STATUS[item.status];
            return <button key={keyOf(item)} type="button" aria-pressed={selected === item} className={selected === item ? "active" : ""} onClick={() => setSelectedKey(keyOf(item))}>
              <span className="capability-row-text"><strong>{item.name}</strong><small>{item.description || item.detail || "没有说明"}</small></span>
              <Badge className={status.className}>{status.label}</Badge>
            </button>;
          })}</div>
        </section>;
      })}</div>
      {selected ? <aside className="capability-detail" aria-label={`${selected.name} 详情`}>
        <strong>{selected.name}</strong>
        {selected.description ? <p>{selected.description}</p> : null}
        <div className="capability-detail-badges"><Badge>{CAPABILITY_SOURCES.find((entry) => entry.source === selected.source)?.title}</Badge><Badge className={CAPABILITY_STATUS[selected.status].className}>{CAPABILITY_STATUS[selected.status].label}</Badge></div>
        {selected.detail ? <p className="capability-detail-problem">{selected.detail}</p> : null}
        <code>{selected.location}</code>
        <p className="capability-detail-note">{CAPABILITY_SOURCES.find((entry) => entry.source === selected.source)?.note}</p>
      </aside> : null}
    </div>}
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
  return <header className="agent-header"><div className="agent-title"><AgentAvatar agent={agent} /><div><p>{agent.agentId}</p><h1>{agent.displayName || agent.name}</h1></div></div><div className="agent-header-summary"><Badge className={agent.connection.state === "connected" ? "success" : agent.issue ? "danger-badge" : ""}>{agent.connection.state}</Badge>{agent.eyeIndicator.stuck ? <Badge className="danger-badge">疑似卡住：有消息超过 3 分钟没处理</Badge> : null}<span>{agent.runtime}</span><span>{agent.model}</span><span>{agent.effort || "default effort"}</span><span>{context}</span><span>累计 {formatNumber(usage.cumulativeTokens)} tokens</span><span>最近一轮 {formatNumber(usage.latestTokens)} tokens</span><span>Compact {formatNumber(compaction.count)} 次 · {compaction.active ? "active" : "idle"}</span><span>最近消息 {agent.lastDeliver ? formatAge(agent.lastDeliver.ageSec) : "暂无"}</span><span>{agent.lastActivity?.detail || activityLabel(agent)}</span></div></header>;
}

export function App() {
  const polling = useStatusPolling();
  const initial = useMemo(() => parseRoute(window.location.search), []);
  const [selectedId, setSelectedId] = useState<string | null>(initial.agentId);
  const [tab, setTab] = useState<AgentTab>(initial.tab);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [configRefreshKey, setConfigRefreshKey] = useState(0);
  const refreshConfig = useCallback(() => setConfigRefreshKey((value) => value + 1), []);
  const [replyDirty, setReplyDirty] = useState(false);
  const [modelDirty, setModelDirty] = useState(false);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  const agentDirty = modelDirty || replyDirty || advancedDirty;
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [personaDirty, setPersonaDirty] = useState(false);
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
    if ((workspaceDirty || personaDirty) && !window.confirm("文件改动尚未保存，确定放弃吗？")) return;
    setWorkspaceDirty(false);
    setPersonaDirty(false);
    setModelDirty(false);
    setReplyDirty(false);
    setAdvancedDirty(false);
    writeRoute(agentId, tab);
    setMobileOpen(false);
  };
  // Every tab stays mounted, so drafts survive switching tabs; only leaving the Agent asks first.
  const selectTab = (next: AgentTab) => writeRoute(selectedId, next);

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
      setModelDirty(false);
      setReplyDirty(false);
      setAdvancedDirty(false);
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

  return <div className="app-shell">
    <aside className="desktop-sidebar"><div className="brand"><img src="/assets/larkin-mark.svg" alt="" /><strong>Larkin <span className="brand-version">v{packageVersion}</span></strong></div><AgentSidebar agents={agents} selectedId={selectedId} onSelect={selectAgent} /><footer>{polling.data?.daemon.running ? `${agents.length} Agents · daemon online` : "daemon offline"}</footer></aside>
    <main className="workspace-shell">
      <div className="app-topbar"><Button className="mobile-menu" aria-label="打开 Agent 导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></Button><div><strong>Larkin <span className="brand-version">v{packageVersion}</span></strong><span>{polling.data?.daemon.running ? "运行中" : "未运行"}</span>{polling.stale ? <Badge className="warning">状态陈旧</Badge> : null}</div></div>
      {polling.error ? <div className="stale-banner" role="alert"><AlertTriangle size={15} />状态刷新失败，保留最后一次数据：{polling.error}<Button onClick={() => void polling.retry()}>重试</Button></div> : null}
      {notice ? <div className="notice" role="status">{notice}<Button aria-label="关闭提示" onClick={() => setNotice(null)}>×</Button></div> : null}
      {polling.loading && !polling.data ? <div className="page-loading"><RefreshCw className="spin" />加载 Agent 工作台…</div> : !selected ? <EmptyState title="还没有配置任何 Agent" detail="先运行 larkin setup。" /> : <>
        <AgentHeader agent={selected} />
        <nav className="agent-tabs" aria-label={`${selected.displayName} 内容页签`} role="tablist">{AGENT_TABS.map((item) => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} onClick={() => selectTab(item)}>{item === "activity" ? <Activity /> : item === "persona" ? <ScrollText /> : item === "reply" ? <MessageSquareText /> : <SlidersHorizontal />}{TAB_LABELS[item]}</button>)}</nav>
        <div className="agent-content" key={selected.agentId}>
          <section role="tabpanel" hidden={tab !== "activity"}><ActivityPanel agent={selected} /></section>
          <section role="tabpanel" hidden={tab !== "persona"}><div className="runtime-page">
            <AgentConfiguration section="model" agentId={selected.agentId} readiness={selected.runtimeReadiness ?? null} onDirtyChange={setModelDirty} onSaved={refreshConfig} refreshKey={configRefreshKey} />
            <AgentPersona agent={selected} onDirtyChange={setPersonaDirty} />
          </div></section>
          <section role="tabpanel" hidden={tab !== "reply"}><AgentConfiguration section="reply" agentId={selected.agentId} readiness={null} onDirtyChange={setReplyDirty} onSaved={refreshConfig} refreshKey={configRefreshKey} /></section>
          <section role="tabpanel" hidden={tab !== "advanced"}><div className="runtime-page">
            <AgentConfiguration section="advanced" agentId={selected.agentId} readiness={null} onDirtyChange={setAdvancedDirty} onSaved={refreshConfig} refreshKey={configRefreshKey} />
            <details className="runtime-details"><summary><ChevronRight size={16} aria-hidden="true" />工作区文件 <small>查看和编辑这个 Agent 工作区里的文本文件</small></summary><Workspace agentId={selected.agentId} onDirtyChange={setWorkspaceDirty} /></details>
            <details className="runtime-details"><summary><ChevronRight size={16} aria-hidden="true" />运行日志 <small>{selected.recentErrors.length ? `最近 ${selected.recentErrors.length} 个错误` : "排查问题时用"}</small></summary><LogsPanel agent={selected} /></details>
          </div></section>
        </div>
      </>}
    </main>
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="选择 Agent" description="搜索、查看状态并切换当前工作区。"><AgentSidebar compact agents={agents} selectedId={selectedId} onSelect={selectAgent} /></Sheet>
  </div>;
}
