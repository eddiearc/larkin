// Streaming card replies: the Host, not the model, delivers the reply.
//
// After the model polls a chat/thread Inbox message, the rest of that Runtime
// turn is rendered live into one Feishu CardKit card that replies to the polled
// message (in the same topic when the source is a thread). The card is a
// timeline: answer text streams with the native typewriter effect, tool calls
// and reasoning summaries are grouped into collapsed panels between the text, and
// a grey status line at the bottom says what the Agent is doing now. When the
// turn ends the steps fold into one "过程回放" panel above the full answer.
//
// The card opens lazily on the first answer text or tool call after the poll, so
// an intentionally silent turn posts nothing. When the turn fails after a poll,
// the Host posts or finishes the card with a visible failure instead of leaving
// the user without a reply. When the card could not be created, so certainly
// nothing reached the chat, the Host replies with a plain text message instead.
//
// A tool step shows the call's raw input, unredacted and on one line; only a failed call is marked,
// and only a call without input falls back to the tool name. A long input keeps its head and tail and
// elides the middle.
//
// The model's current reply anchor is the canonical Inbox `last_source`, which a
// successful scoped poll sets and the Runtime turn boundary clears. A poll is a
// tool call, so the source is re-resolved after tool activity and at a bounded
// interval; output produced before any poll has no anchor and is not delivered.
//
// A group message that woke the Agent without an @, or never woke it (an Inbox
// audit reads it later), opens no card: the Agent replies by command, so
// deciding to stay silent leaves nothing in the group.
//
// The mode is the global `replyMode` in Larkin config (dashboard 全局设置), else LARKIN_REPLY_MODE;
// it defaults to `cli`, the model-driven `+messages-reply`, and card mode is opt-in.

import type { NormalizedRuntimeEvent } from "../runtime/runtime-contracts.js";

export { replyModeFromEnv, type ReplyMode } from "../platform/reply-mode.js";

export interface StreamReplySource { deliveryTarget: string; deliveryAnchor: string; replyByCommand?: boolean }

type ApiCall = (request: Record<string, unknown>) => Promise<unknown>;

/** The slice of the Feishu OpenAPI client (`LarkChannel.rawClient`) the card renderer uses. */
export interface CardKitClient {
  cardkit: { v1: {
    card: { create: ApiCall; update: ApiCall; settings: ApiCall };
    cardElement: { content: ApiCall };
  } };
  im: { v1: { message: { reply: ApiCall } } };
}

export interface StreamReplyChannel { rawClient?: CardKitClient }

export interface StreamReplyOptions {
  channelFor(agentId: string): StreamReplyChannel | undefined;
  resolveSource(agentId: string): StreamReplySource | null;
  log?: (...parts: unknown[]) => void;
  /** Minimum gap between card updates. */
  throttleMs?: number;
  /** Re-read the Inbox source at least this often while no fresher tool boundary forced it. */
  resolveIntervalMs?: number;
  now?: () => number;
}

export const STREAM_REPLY_INITIAL_TEXT = "Thinking…";
export const STREAM_REPLY_FAILURE_TEXT = "Something went wrong while handling this message, so the reply is incomplete. Please try again later.";
export const STREAM_REPLY_SILENT_TEXT = "Done. Nothing to reply.";

const MAX_THINKING_CHARS = 600;
const MAX_TOOL_INPUT_CHARS = 200;
const MAX_STEP_LINES = 60;
const SUMMARY_CHARS = 50;

interface ReplyAddress { key: string; chatId: string; anchor: string; inThread: boolean }

/** Map a canonical Inbox source to a card address; only IM chat/thread sources with a real om_ anchor qualify. */
export function replyAddressOf(source: StreamReplySource | null): ReplyAddress | null {
  if (!source || source.replyByCommand || !/^om_[A-Za-z0-9_-]+$/.test(source.deliveryAnchor)) return null;
  const chat = /^chat:([^:]+)$/.exec(source.deliveryTarget);
  if (chat) return { key: `${source.deliveryTarget}#${source.deliveryAnchor}`, chatId: chat[1], anchor: source.deliveryAnchor, inThread: false };
  const thread = /^thread:([^:]+):([^:]+)$/.exec(source.deliveryTarget);
  if (thread) return { key: `${source.deliveryTarget}#${source.deliveryAnchor}`, chatId: thread[1], anchor: source.deliveryAnchor, inThread: true };
  return null;
}

type Step =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; key: string; name: string; input: string; status: "running" | "completed" | "failed" };
type Entry = { kind: "text"; text: string } | { kind: "steps"; steps: Step[] };


/** One line of a tool input; past the limit the middle is replaced by an ellipsis. */
function toolInputForCard(input: string): string {
  const line = input.replace(/\s+/g, " ").trim();
  if (line.length <= MAX_TOOL_INPUT_CHARS) return line;
  const tail = Math.floor((MAX_TOOL_INPUT_CHARS - 1) / 3);
  return `${line.slice(0, MAX_TOOL_INPUT_CHARS - 1 - tail)}…${line.slice(-tail)}`;
}

/** What a tool step shows: its raw input as inline code, or the tool name when it has none. */
function toolLabel(step: { name: string; input: string }): string {
  return step.input ? `\`${step.input.replace(/`/g, "'")}\`` : step.name;
}

function stepLines(steps: readonly Step[]): string[] {
  const lines = steps.map((step) => {
    if (step.kind === "thinking") {
      const text = step.text.replace(/\s+/g, " ").trim();
      return `> ${text.length > MAX_THINKING_CHARS ? `${text.slice(0, MAX_THINKING_CHARS - 1)}…` : text}`;
    }
    return `- ${toolLabel(step)}${step.status === "failed" ? " · failed" : ""}`;
  });
  return lines.length > MAX_STEP_LINES ? [`… ${lines.length - MAX_STEP_LINES} earlier steps omitted`, ...lines.slice(-MAX_STEP_LINES)] : lines;
}

function stepsTitle(steps: readonly Step[]): string {
  const tools = steps.filter((step) => step.kind === "tool").length;
  const thought = steps.some((step) => step.kind === "thinking");
  const calls = `${tools} tool call${tools === 1 ? "" : "s"}`;
  if (tools && thought) return `Thinking · ${calls}`;
  if (tools) return calls;
  return "Thinking";
}

function panel(elementId: string, title: string, content: string): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    element_id: elementId,
    expanded: false,
    header: {
      title: { tag: "markdown", content: `<font color='grey'>${title}</font>` },
      vertical_align: "center",
      padding: "0px 0px 0px 0px",
      icon: { tag: "standard_icon", token: "right-small-ccm_outlined", color: "grey", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: 90,
    },
    elements: [{ tag: "markdown", element_id: `${elementId}c`, content }],
  };
}

function cardShell(elements: unknown[], config: Record<string, unknown>): Record<string, unknown> {
  return { schema: "2.0", config: { wide_screen_mode: true, ...config }, body: { direction: "vertical", vertical_spacing: "12px", elements } };
}

function truncateSummary(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= SUMMARY_CHARS ? cleaned : `${cleaned.slice(0, SUMMARY_CHARS - 1)}…`;
}

interface MarkdownSlot { elementId: string; content: string }

function markdownSlots(value: unknown, slots: MarkdownSlot[] = []): MarkdownSlot[] {
  if (!value || typeof value !== "object") return slots;
  if (Array.isArray(value)) { for (const item of value) markdownSlots(item, slots); return slots; }
  const record = value as Record<string, unknown>;
  if (record.tag === "markdown" && typeof record.element_id === "string" && typeof record.content === "string") {
    slots.push({ elementId: record.element_id, content: record.content });
  }
  for (const item of Object.values(record)) markdownSlots(item, slots);
  return slots;
}

/** Card JSON with every addressable markdown body blanked, so only structural changes differ. */
function structureOf(card: unknown): string {
  return JSON.stringify(card, function (this: Record<string, unknown>, key: string, value: unknown) {
    return key === "content" && this.tag === "markdown" && typeof this.element_id === "string" ? "" : value;
  });
}

function responseData(response: unknown, label: string): Record<string, unknown> {
  const record = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  if (typeof record.code === "number" && record.code !== 0) throw new Error(`${label} code=${record.code} ${String(record.msg ?? "")}`.trim());
  return (record.data && typeof record.data === "object" ? record.data : record) as Record<string, unknown>;
}

class CardReply {
  readonly done: Promise<void>;
  private readonly entries: Entry[] = [];
  private status = STREAM_REPLY_INITIAL_TEXT;
  private toolSerial = 0;
  private cardId = "";
  private messageId = "";
  private sequence = 0;
  private applied: Record<string, unknown> | null = null;
  private elementStreaming = true;
  private dead = false;
  /** The card failed before Feishu could have posted anything, so a plain reply cannot duplicate it. */
  private unsent = false;
  private chain: Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private finished = false;
  private readonly startedAt: number;
  private settle!: () => void;

  constructor(readonly address: ReplyAddress, private readonly client: CardKitClient, private readonly throttleMs: number,
    private readonly now: () => number, private readonly log: (...parts: unknown[]) => void) {
    this.startedAt = now();
    this.done = new Promise<void>((resolve) => { this.settle = resolve; });
    this.chain = this.start();
  }

  /** The answer text exactly as the model wrote it; blank blocks are skipped. */
  get answer(): string {
    return this.entries.flatMap((entry) => entry.kind === "text" && entry.text.trim() ? [entry.text] : []).join("\n\n");
  }

  appendText(text: string, newBlock: boolean): void {
    if (this.finished || !text) return;
    const last = this.entries.at(-1);
    if (last?.kind === "text") {
      if (newBlock && last.text && !last.text.endsWith("\n\n")) last.text += last.text.endsWith("\n") ? "\n" : "\n\n";
      last.text += text;
    } else {
      this.entries.push({ kind: "text", text });
    }
    this.status = "Replying…";
    this.schedule();
  }

  appendThinking(text: string): void {
    if (this.finished || !text.trim()) return;
    const steps = this.stepsEntry();
    const last = steps.at(-1);
    if (last?.kind === "thinking") last.text += text;
    else steps.push({ kind: "thinking", text });
    this.status = STREAM_REPLY_INITIAL_TEXT;
    this.schedule();
  }

  toolStarted(name: string, input: string, toolId?: string): void {
    if (this.finished) return;
    this.toolSerial += 1;
    const step: Extract<Step, { kind: "tool" }> = { kind: "tool", key: toolId || `#${this.toolSerial}`, name, input: toolInputForCard(input), status: "running" };
    this.stepsEntry().push(step);
    this.status = `Running ${toolLabel(step)}`;
    this.schedule();
  }

  toolFinished(ok: boolean, toolId?: string, name?: string): void {
    if (this.finished) return;
    const tools = this.entries.flatMap((entry) => entry.kind === "steps" ? entry.steps : [])
      .filter((step): step is Extract<Step, { kind: "tool" }> => step.kind === "tool" && step.status === "running");
    const tool = (toolId ? tools.find((candidate) => candidate.key === toolId) : undefined)
      ?? [...tools].reverse().find((candidate) => !toolId && (!name || candidate.name === name));
    if (!tool) return;
    tool.status = ok ? "completed" : "failed";
    if (!tools.some((candidate) => candidate !== tool)) this.status = STREAM_REPLY_INITIAL_TEXT;
    this.schedule();
  }

  /** Close the card; `failure` keeps any partial answer and appends the failure notice. */
  finish(failure?: string): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const final = this.renderFinal(failure);
    const plain = failure ? (this.answer ? `${this.answer}\n\n${failure}` : failure) : this.answer || STREAM_REPLY_SILENT_TEXT;
    this.chain = this.chain.then(() => this.deliverFinal(final, plain)).finally(() => this.settle());
  }

  private async deliverFinal(final: Record<string, unknown>, plain: string): Promise<void> {
    if (this.dead) {
      if (this.unsent) await this.replyPlain(plain);
      return;
    }
    // The card counts as sent only once its final body landed; one retry covers a transient failure.
    const landed = await this.apply(final) || await this.apply(final);
    await this.closeStreaming(final);
    if (landed) this.log(`流式卡片已发送 anchor=${this.address.anchor} message=${this.messageId} chars=${this.answer.length}`);
    else this.log(`流式卡片最终内容未能写入，用户只看到部分回复 anchor=${this.address.anchor} message=${this.messageId}`);
  }

  private async replyPlain(text: string): Promise<void> {
    try {
      const sent = responseData(await this.client.im.v1.message.reply({
        path: { message_id: this.address.anchor },
        data: { msg_type: "text", content: JSON.stringify({ text }), reply_in_thread: this.address.inThread },
      }), "im.message.reply");
      this.log(`流式卡片不可用，已改用普通消息回复 anchor=${this.address.anchor} message=${String(sent.message_id ?? "")} chars=${text.length}`);
    } catch (error) {
      this.log(`普通消息回复也失败 anchor=${this.address.anchor}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private stepsEntry(): Step[] {
    const last = this.entries.at(-1);
    if (last?.kind === "steps") return last.steps;
    const entry: Entry = { kind: "steps", steps: [] };
    this.entries.push(entry);
    return entry.steps;
  }

  private renderStreaming(): Record<string, unknown> {
    const elements: unknown[] = this.entries.map((entry, index) => entry.kind === "text"
      ? { tag: "markdown", element_id: `t${index}`, content: entry.text || " " }
      : panel(`p${index}`, stepsTitle(entry.steps), stepLines(entry.steps).join("\n") || " "));
    elements.push({ tag: "markdown", element_id: "status", content: `<font color='grey'>${this.status}</font>`, text_size: "notation" });
    return cardShell(elements, {
      streaming_mode: true,
      summary: { content: "Replying…" },
      streaming_config: { print_frequency_ms: { default: 30 }, print_step: { default: 8 }, print_strategy: "fast" },
    });
  }

  private renderFinal(failure?: string): Record<string, unknown> {
    // A Runtime that reports no tool results leaves calls "running"; the turn is over now.
    const steps = this.entries.flatMap((entry) => entry.kind === "steps" ? entry.steps : [])
      .map((step) => step.kind === "tool" && step.status === "running" ? { ...step, status: "completed" as const } : step);
    const answer = this.answer;
    const body = failure ? (answer ? `${answer}\n\n<font color='grey'>${failure}</font>` : failure) : answer || STREAM_REPLY_SILENT_TEXT;
    const elements: unknown[] = [];
    if (steps.length) {
      const seconds = Math.max(1, Math.round((this.now() - this.startedAt) / 1000));
      elements.push(panel("replay", `Replay · ${stepsTitle(steps)} · ${seconds}s`, stepLines(steps).join("\n")));
    }
    elements.push({ tag: "markdown", element_id: "answer", content: body });
    return cardShell(elements, { streaming_mode: true, summary: { content: truncateSummary(failure && !answer ? failure : body) } });
  }

  private async start(): Promise<void> {
    // Only a reply request that failed in transit may still have posted the card.
    let mayHavePosted = false;
    try {
      const card = this.renderStreaming();
      const created = responseData(await this.client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } }), "cardkit.card.create");
      this.cardId = String(created.card_id ?? "");
      if (!this.cardId) throw new Error("cardkit.card.create returned no card_id");
      mayHavePosted = true;
      const response = await this.client.im.v1.message.reply({
        path: { message_id: this.address.anchor },
        data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: this.cardId } }), reply_in_thread: this.address.inThread },
      });
      mayHavePosted = false;
      const sent = responseData(response, "im.message.reply");
      this.messageId = String(sent.message_id ?? "");
      this.applied = card;
    } catch (error) {
      this.dead = true;
      this.unsent = !mayHavePosted;
      this.log(`流式卡片回复失败 anchor=${this.address.anchor}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private schedule(): void {
    if (this.timer || this.finished) return;
    const wait = Math.max(0, this.lastFlushAt + this.throttleMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastFlushAt = this.now();
      const next = this.renderStreaming();
      this.chain = this.chain.then(async () => { await this.apply(next); });
    }, wait);
    this.timer.unref?.();
  }

  /** Bring the card to `next`; false when Feishu did not take the update. */
  private async apply(next: Record<string, unknown>): Promise<boolean> {
    if (this.dead || !this.cardId || !this.applied) return false;
    const previous = this.applied;
    try {
      if (this.elementStreaming && structureOf(previous) === structureOf(next)) {
        const before = new Map(markdownSlots(previous).map((slot) => [slot.elementId, slot.content]));
        try {
          for (const slot of markdownSlots(next)) {
            if (before.get(slot.elementId) === slot.content) continue;
            this.sequence += 1;
            responseData(await this.client.cardkit.v1.cardElement.content({
              path: { card_id: this.cardId, element_id: slot.elementId },
              data: { content: slot.content, sequence: this.sequence, uuid: `c_${this.cardId}_${this.sequence}` },
            }), "cardkit.cardElement.content");
          }
          this.applied = next;
          return true;
        } catch (error) {
          this.elementStreaming = false;
          this.log(`流式卡片逐段更新失败，改为整卡更新 anchor=${this.address.anchor}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.sequence += 1;
      responseData(await this.client.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: "card_json", data: JSON.stringify(next) }, sequence: this.sequence, uuid: `u_${this.cardId}_${this.sequence}` },
      }), "cardkit.card.update");
      this.applied = next;
      return true;
    } catch (error) {
      this.log(`流式卡片更新失败 anchor=${this.address.anchor}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async closeStreaming(final: Record<string, unknown>): Promise<void> {
    if (this.dead || !this.cardId) return;
    this.sequence += 1;
    const summary = ((final.config as Record<string, unknown>).summary ?? { content: "" }) as Record<string, unknown>;
    try {
      responseData(await this.client.cardkit.v1.card.settings({
        path: { card_id: this.cardId },
        data: { settings: JSON.stringify({ config: { streaming_mode: false, summary } }), sequence: this.sequence, uuid: `s_${this.cardId}_${this.sequence}` },
      }), "cardkit.card.settings");
    } catch (error) {
      this.log(`流式卡片收尾失败 anchor=${this.address.anchor}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Steps observed after the poll but before the card opened; replayed into the card when it opens. */
type Buffered = { kind: "thinking"; text: string };

interface TurnState {
  card: CardReply | null;
  needsResolve: boolean;
  lastResolveAt: number;
  /** Address of the latest poll even before any output arrives; used for failure replies. */
  lastAddress: ReplyAddress | null;
  buffered: Buffered[];
  failed: string | null;
  /** Diagnostics: assistant text seen this turn, cards opened for it, tool calls, raw Inbox source. */
  textChars: number;
  cards: number;
  tools: number;
  source: string;
  /** The polled message did not @ the Agent, so its text opens no card. */
  replyByCommand: boolean;
}

export class StreamReplyCoordinator {
  private readonly turns = new Map<string, TurnState>();
  private readonly log: (...parts: unknown[]) => void;
  private readonly throttleMs: number;
  private readonly resolveIntervalMs: number;
  private readonly now: () => number;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: StreamReplyOptions) {
    this.log = options.log ?? (() => {});
    this.throttleMs = options.throttleMs ?? 300;
    this.resolveIntervalMs = options.resolveIntervalMs ?? 500;
    this.now = options.now ?? Date.now;
  }

  observe(agentId: string, event: NormalizedRuntimeEvent): void {
    if (event.type === "turn-start") {
      this.endTurn(agentId);
      this.turns.set(agentId, this.freshTurn());
      return;
    }
    const turn = this.turns.get(agentId);
    if (event.type === "turn-end" || event.type === "closed") {
      if (!turn) return;
      if (event.type === "closed") turn.failed ??= STREAM_REPLY_FAILURE_TEXT;
      this.endTurn(agentId);
      return;
    }
    if (!turn) return;
    if (event.type === "activity" && event.activity === "tool") {
      turn.tools += 1;
      // Resolve before this call runs: a poll's own source only exists after it returns.
      const card = this.cardFor(agentId, turn, true);
      card?.toolStarted(event.name || "tool", event.text || "", event.toolId);
      turn.needsResolve = true;
      return;
    }
    if (event.type === "tool-result") {
      // A poll's source exists once it returns; record it now so a later failure answers that message.
      turn.needsResolve = true;
      this.currentAddress(agentId, turn);
      turn.card?.toolFinished(event.ok, event.toolId, event.name);
      return;
    }
    if (event.type === "activity" && event.activity === "thinking" && event.text) {
      const card = this.cardFor(agentId, turn, false);
      if (card) card.appendThinking(event.text);
      else if (turn.lastAddress) turn.buffered.push({ kind: "thinking", text: event.text });
      return;
    }
    if (event.type === "error" || (event.type === "input-error" && event.willRetry !== true)) {
      turn.failed = STREAM_REPLY_FAILURE_TEXT;
      // The Host replaces a session after a terminal error and drops its later events, so end the turn now.
      if (event.type === "error") this.endTurn(agentId);
      return;
    }
    if (event.type === "text-delta" && event.text) {
      turn.textChars += event.text.length;
      this.cardFor(agentId, turn, true)?.appendText(event.text, event.newBlock === true);
    }
  }

  /** Resolve once every card opened so far has finished streaming (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private freshTurn(): TurnState {
    return { card: null, needsResolve: true, lastResolveAt: 0, lastAddress: null, buffered: [], failed: null,
      textChars: 0, cards: 0, tools: 0, source: "none", replyByCommand: false };
  }

  /** The card for the current source, opening (or switching) it when `open` is allowed. */
  private cardFor(agentId: string, turn: TurnState, open: boolean): CardReply | null {
    const address = this.currentAddress(agentId, turn);
    if (!address) {
      if (turn.card) { turn.card.finish(); turn.card = null; }
      turn.buffered = [];
      return null;
    }
    if (turn.card && turn.card.address.key === address.key) return turn.card;
    if (turn.card) { turn.card.finish(); turn.card = null; turn.buffered = []; }
    if (!open) return null;
    turn.card = this.open(agentId, address);
    if (!turn.card) return null;
    turn.cards += 1;
    for (const item of turn.buffered.splice(0)) turn.card.appendThinking(item.text);
    return turn.card;
  }

  private currentAddress(agentId: string, turn: TurnState): ReplyAddress | null {
    const due = turn.needsResolve || this.now() - turn.lastResolveAt >= this.resolveIntervalMs;
    // A tool result refreshes lastAddress before the next card opens. Inside the cache
    // window that refreshed address is authoritative; the open card can still be the previous poll.
    if (!due) return turn.lastAddress;
    turn.needsResolve = false;
    turn.lastResolveAt = this.now();
    let source: StreamReplySource | null = null;
    try { source = this.options.resolveSource(agentId); }
    catch (error) { this.log(`读取当前 Inbox source 失败 agent=${agentId}: ${error instanceof Error ? error.message : String(error)}`); }
    const address = replyAddressOf(source);
    turn.source = source ? `${source.deliveryTarget}#${source.deliveryAnchor}` : "none";
    turn.replyByCommand = Boolean(source?.replyByCommand);
    if (address && turn.lastAddress?.key !== address.key) turn.buffered = [];
    turn.lastAddress = address;
    return address;
  }

  private open(agentId: string, address: ReplyAddress): CardReply | null {
    const client = this.options.channelFor(agentId)?.rawClient;
    if (!client) { this.log(`没有可用的飞书连接，无法发送流式卡片 agent=${agentId}`); return null; }
    const card = new CardReply(address, client, this.throttleMs, this.now, this.log);
    this.pending.add(card.done);
    void card.done.finally(() => this.pending.delete(card.done));
    return card;
  }

  private endTurn(agentId: string): void {
    const turn = this.turns.get(agentId);
    if (!turn) return;
    this.turns.delete(agentId);
    if (turn.textChars || turn.failed || turn.cards) {
      this.log(`流式回复回合结束 agent=${agentId} text=${turn.textChars} cards=${turn.cards} tools=${turn.tools} source=${turn.source}${turn.failed ? " failed" : ""}`
        + (turn.textChars && !turn.cards ? (turn.replyByCommand
          ? "（本回合领到的消息没有 @ 机器人，Agent 输出的文字不会自动发到飞书）"
          : "（本回合没有领到消息，Agent 输出的文字没有可回复的对象，没有发到飞书）") : ""));
    }
    if (!turn.failed) { turn.card?.finish(); return; }
    // A failed turn after a poll must not leave the user unanswered. Refresh the source first, so
    // the failure answers the latest polled message rather than an earlier card's.
    const previous = turn.lastAddress;
    turn.needsResolve = true;
    const address = this.currentAddress(agentId, turn) ?? previous;
    if (turn.card && address && turn.card.address.key !== address.key) { turn.card.finish(); turn.card = null; }
    if (!turn.card && address) turn.card = this.open(agentId, address);
    turn.card?.finish(turn.failed);
  }
}
