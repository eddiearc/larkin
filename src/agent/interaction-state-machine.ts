import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentStateStore } from "./agent-state-store.js";

type JsonObject = Record<string, unknown>;
type ReflexStatus = "pending" | "succeeded" | "failed" | "uncertain" | "timed_out";
type ResolveStatus = "succeeded" | "failed";
type CompletionStatus = ResolveStatus | "timed_out";
type ResultScalarType = "string" | "number" | "integer" | "boolean";

export interface InteractionResultProperty {
  type: ResultScalarType;
  max_length?: number;
  enum?: Array<string | number | boolean>;
}

export interface InteractionResultSchema {
  properties: Record<string, InteractionResultProperty>;
  required: string[];
  additional_properties: false;
}

export interface InteractionView {
  title: string;
  markdown: string;
  terminal?: boolean;
}

export interface InteractionEffect {
  id: "reminder.schedule";
  args: { title: string; fire_at?: string; delay_seconds?: number };
}

export interface InteractionAction {
  from: string[];
  label: string;
  success_state: string;
  failure_state: string;
  timeout_state: string;
  processing_state: string;
  agent: { instruction: string; timeout_seconds?: number };
  reflex: { toast: string; effect?: InteractionEffect };
  result_schema: InteractionResultSchema;
}

export interface InteractionDefinition {
  schema_version: 1;
  initial_state: string;
  expires_in_seconds: number;
  transition_limit?: number;
  retention_seconds?: number;
  audience: { open_ids: string[] };
  states: Record<string, InteractionView>;
  actions: Record<string, InteractionAction>;
}

export interface InteractionInstance extends JsonObject {
  instance_id: string;
  definition_id: string;
  owner_agent_id: string;
  expected_chat_id: string;
  message_id: string | null;
  current_state: string;
  state_version: number;
  active_run_id: string | null;
  transition_count: number;
  expires_at: string;
  desired_projection_version: number;
  projected_version: number;
  created_at: string;
  updated_at: string;
}

export interface InteractionRun extends JsonObject {
  run_id: string;
  instance_id: string;
  action_id: string;
  callback_id: string;
  operator_open_id: string;
  chat_id: string;
  message_id: string;
  source_state: string;
  source_version: number;
  expected_resolve_version: number;
  callback_received_at: string;
  reflex_deadline_at: string;
  reflex_completed_at: string | null;
  reflex: { status: ReflexStatus; summary: string; data: JsonObject };
  agent_delivery_status: "pending" | "delivered";
  agent_deadline_at: string;
  resolve: null | { status: CompletionStatus; summary: string; data: JsonObject; resolved_at: string };
  created_at: string;
  updated_at: string;
}

export interface InteractionOutbox extends JsonObject {
  outbox_id: string;
  kind: "agent_wake" | "card_projection";
  run_id: string;
  status: "waiting_reflex" | "pending" | "delivered";
  payload: JsonObject;
  created_at: string;
  updated_at: string;
  attempts: number;
  last_error?: string | null;
}

interface InteractionState {
  version: 1;
  definitions: Array<{ definition_id: string; owner_agent_id: string; spec: InteractionDefinition; created_at: string }>;
  instances: InteractionInstance[];
  runs: InteractionRun[];
  action_refs: Array<{ ref: string; instance_id: string; action_id: string }>;
  outbox: InteractionOutbox[];
}

const EMPTY_STATE = (): InteractionState => ({ version: 1, definitions: [], instances: [], runs: [], action_refs: [], outbox: [] });
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{2,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{2,128}$/;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
export const MAX_INTERACTION_STATE_BYTES = 5 * 1024 * 1024;
const MAX_INSTANCES = 500;
const MAX_RUNS = 500;
const MAX_OUTBOX = 1_000;
const REFLEX_RECOVERY_MS = 3_000;
const ALLOWED_DEFINITION_KEYS = new Set(["schema_version", "initial_state", "expires_in_seconds", "transition_limit", "retention_seconds", "audience", "states", "actions"]);
const FORBIDDEN_KEY = /(?:^|_)(?:code|script|command|shell|url|credential|secret|token)(?:$|_)/i;
const RESERVED_GRAPH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROCESSING_TITLE = "处理中";
const PROCESSING_MARKDOWN = "请求已受理，Agent 正在处理；当前状态不代表业务已经完成。";
const PROCESSING_TOAST = "已受理，Agent 正在处理，完成后会更新卡片。";

function record(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain or null-prototype object`);
  return value as JsonObject;
}

function text(value: unknown, label: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string <= ${max}`);
  return value.trim();
}

function safeJson<T>(value: T, label: string, max = MAX_RESULT_BYTES): T {
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new Error(`${label} must be JSON serializable`); }
  if (encoded === undefined || Buffer.byteLength(encoded) > max) throw new Error(`${label} exceeds ${max} bytes`);
  return JSON.parse(encoded) as T;
}

function scanForbiddenKeys(value: unknown, path = "definition"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (RESERVED_GRAPH_KEYS.has(key)) throw new Error(`${path}.${key} is reserved`);
    if (FORBIDDEN_KEY.test(key)) throw new Error(`${path}.${key} is not allowed`);
    scanForbiddenKeys(item, `${path}.${key}`);
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateResultSchema(value: unknown, actionId: string): InteractionResultSchema {
  const schema = record(value, `definition.actions.${actionId}.result_schema`);
  if (Object.keys(schema).some((key) => !["properties", "required", "additional_properties"].includes(key))) throw new Error(`action ${actionId}.result_schema contains unsupported fields`);
  if (schema.additional_properties !== false) throw new Error(`action ${actionId}.result_schema.additional_properties must be false`);
  const rawProperties = record(schema.properties, `action ${actionId}.result_schema.properties`);
  const entries = Object.entries(rawProperties);
  if (entries.length > 20) throw new Error(`action ${actionId}.result_schema supports at most 20 properties`);
  const properties = Object.create(null) as Record<string, InteractionResultProperty>;
  for (const [name, rawProperty] of entries) {
    if (!ID.test(name) || RESERVED_GRAPH_KEYS.has(name)) throw new Error(`action ${actionId}.result_schema property ${name} is invalid`);
    const property = record(rawProperty, `action ${actionId}.result_schema.properties.${name}`);
    if (Object.keys(property).some((key) => !["type", "max_length", "enum"].includes(key))) throw new Error(`result property ${name} contains unsupported fields`);
    if (!(["string", "number", "integer", "boolean"] as unknown[]).includes(property.type)) throw new Error(`result property ${name}.type is invalid`);
    const maxLength = property.max_length === undefined ? undefined : Number(property.max_length);
    if (maxLength !== undefined && (property.type !== "string" || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 4_000)) throw new Error(`result property ${name}.max_length is invalid`);
    let enumValues: Array<string | number | boolean> | undefined;
    if (property.enum !== undefined) {
      if (!Array.isArray(property.enum) || property.enum.length < 1 || property.enum.length > 20 || property.enum.some((item) => !["string", "number", "boolean"].includes(typeof item))) throw new Error(`result property ${name}.enum is invalid`);
      enumValues = safeJson(property.enum, `result property ${name}.enum`, 4_000) as Array<string | number | boolean>;
      const enumTypeValid = enumValues.every((item) => property.type === "integer" ? Number.isInteger(item)
        : property.type === "number" ? typeof item === "number" && Number.isFinite(item)
          : typeof item === property.type);
      if (!enumTypeValid) throw new Error(`result property ${name}.enum does not match its declared type`);
    }
    properties[name] = { type: property.type as ResultScalarType, ...(maxLength === undefined ? {} : { max_length: maxLength }), ...(enumValues ? { enum: enumValues } : {}) };
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length > 20)) throw new Error(`action ${actionId}.result_schema.required must be an array with at most 20 values`);
  const required = schema.required === undefined || (schema.required as unknown[]).length === 0
    ? [] : stringArray(schema.required, `action ${actionId}.result_schema.required`, ID, 20);
  for (const name of required) if (!hasOwn(properties, name)) throw new Error(`result schema required property ${name} is not declared`);
  return { properties, required, additional_properties: false };
}

function validateResultData(schema: InteractionResultSchema, value: JsonObject): JsonObject {
  const data = record(safeJson(value, "resolve data"), "resolve data");
  for (const key of Object.keys(data)) {
    if (RESERVED_GRAPH_KEYS.has(key) || !hasOwn(schema.properties, key)) throw new Error(`resolve data property ${key} is not declared`);
  }
  for (const key of schema.required) if (!hasOwn(data, key)) throw new Error(`resolve data requires property ${key}`);
  for (const [key, raw] of Object.entries(data)) {
    const property = schema.properties[key];
    const validType = property.type === "integer" ? Number.isInteger(raw)
      : property.type === "number" ? typeof raw === "number" && Number.isFinite(raw)
        : typeof raw === property.type;
    if (!validType) throw new Error(`resolve data property ${key} must be ${property.type}`);
    if (property.type === "string" && property.max_length !== undefined && (raw as string).length > property.max_length) throw new Error(`resolve data property ${key} exceeds max_length`);
    if (property.enum && !property.enum.some((candidate) => sameJson(candidate, raw))) throw new Error(`resolve data property ${key} is outside enum`);
  }
  return data;
}

function stringArray(value: unknown, label: string, validator: RegExp, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new Error(`${label} must contain 1-${max} values`);
  const result = value.map((item) => text(item, label, 160));
  if (result.some((item) => !validator.test(item))) throw new Error(`${label} contains an invalid value`);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

export function validateInteractionDefinition(input: unknown): InteractionDefinition {
  const sanitized = safeJson(input, "definition", MAX_SPEC_BYTES);
  scanForbiddenKeys(sanitized);
  const source = record(sanitized, "definition");
  for (const key of Object.keys(source)) if (!ALLOWED_DEFINITION_KEYS.has(key)) throw new Error(`definition.${key} is not allowed`);
  if (source.schema_version !== 1) throw new Error("definition.schema_version must be 1");
  const initialState = text(source.initial_state, "definition.initial_state", 64);
  if (!ID.test(initialState)) throw new Error("definition.initial_state is invalid");
  const expires = Number(source.expires_in_seconds);
  if (!Number.isInteger(expires) || expires < 30 || expires > 30 * 86_400) throw new Error("definition.expires_in_seconds must be 30..2592000");
  const transitionLimit = source.transition_limit === undefined ? 20 : Number(source.transition_limit);
  if (!Number.isInteger(transitionLimit) || transitionLimit < 1 || transitionLimit > 100) throw new Error("definition.transition_limit must be 1..100");
  const retention = source.retention_seconds === undefined ? 7 * 86_400 : Number(source.retention_seconds);
  if (!Number.isInteger(retention) || retention < 3600 || retention > 30 * 86_400) throw new Error("definition.retention_seconds must be 3600..2592000");

  const audienceSource = record(source.audience, "definition.audience");
  if (Object.keys(audienceSource).some((key) => key !== "open_ids")) throw new Error("definition.audience only supports open_ids");
  const openIds = stringArray(audienceSource.open_ids, "definition.audience.open_ids", OPEN_ID, 100);

  const stateSource = record(source.states, "definition.states");
  const stateEntries = Object.entries(stateSource);
  if (stateEntries.length < 2 || stateEntries.length > 20) throw new Error("definition.states must contain 2-20 states");
  const states = Object.create(null) as Record<string, InteractionView>;
  for (const [stateId, raw] of stateEntries) {
    if (!ID.test(stateId)) throw new Error(`invalid state id: ${stateId}`);
    const view = record(raw, `definition.states.${stateId}`);
    if (Object.keys(view).some((key) => !["title", "markdown", "terminal"].includes(key))) throw new Error(`definition.states.${stateId} contains unsupported fields`);
    states[stateId] = {
      title: text(view.title, `definition.states.${stateId}.title`, 120),
      markdown: text(view.markdown, `definition.states.${stateId}.markdown`, 8_000),
      ...(view.terminal === true ? { terminal: true } : {}),
    };
  }
  if (!hasOwn(states, initialState)) throw new Error("definition.initial_state must exist");
  if (states[initialState].terminal) throw new Error("definition.initial_state cannot be terminal");

  const actionSource = record(source.actions, "definition.actions");
  const actionEntries = Object.entries(actionSource);
  if (actionEntries.length < 1 || actionEntries.length > 20) throw new Error("definition.actions must contain 1-20 actions");
  const actions = Object.create(null) as Record<string, InteractionAction>;
  for (const [actionId, raw] of actionEntries) {
    if (!ID.test(actionId)) throw new Error(`invalid action id: ${actionId}`);
    const action = record(raw, `definition.actions.${actionId}`);
    if (Object.keys(action).some((key) => !["from", "label", "success_state", "failure_state", "timeout_state", "processing_state", "agent", "reflex", "result_schema"].includes(key))) {
      throw new Error(`definition.actions.${actionId} contains unsupported fields`);
    }
    const from = stringArray(action.from, `definition.actions.${actionId}.from`, ID, 20);
    const successState = text(action.success_state, `${actionId}.success_state`, 64);
    const failureState = text(action.failure_state, `${actionId}.failure_state`, 64);
    const timeoutState = action.timeout_state === undefined ? failureState : text(action.timeout_state, `${actionId}.timeout_state`, 64);
    const processingState = text(action.processing_state, `${actionId}.processing_state`, 64);
    for (const target of [...from, successState, failureState, timeoutState, processingState]) if (!hasOwn(states, target)) throw new Error(`action ${actionId} references missing state ${target}`);
    if (from.some((stateId) => states[stateId].terminal)) throw new Error(`action ${actionId} cannot start from a terminal state`);
    if (states[processingState].terminal) throw new Error(`action ${actionId}.processing_state cannot be terminal`);
    const agent = record(action.agent, `definition.actions.${actionId}.agent`);
    if (Object.keys(agent).some((key) => !["instruction", "timeout_seconds"].includes(key))) throw new Error(`action ${actionId}.agent contains unsupported fields`);
    const timeout = agent.timeout_seconds === undefined ? 900 : Number(agent.timeout_seconds);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 86_400) throw new Error(`action ${actionId}.agent.timeout_seconds must be 30..86400`);
    const reflex = record(action.reflex, `definition.actions.${actionId}.reflex`);
    if (Object.keys(reflex).some((key) => !["toast", "effect"].includes(key))) throw new Error(`action ${actionId}.reflex contains unsupported fields`);
    let effect: InteractionEffect | undefined;
    if (reflex.effect !== undefined) {
      const rawEffect = record(reflex.effect, `definition.actions.${actionId}.reflex.effect`);
      if (rawEffect.id !== "reminder.schedule") throw new Error(`unknown interaction effect: ${String(rawEffect.id)}`);
      if (Object.keys(rawEffect).some((key) => !["id", "args"].includes(key))) throw new Error("effect contains unsupported fields");
      const args = record(rawEffect.args, "effect.args");
      if (Object.keys(args).some((key) => !["title", "fire_at", "delay_seconds"].includes(key))) throw new Error("reminder.schedule args contain unsupported fields");
      const fireAt = args.fire_at === undefined ? undefined : text(args.fire_at, "effect.args.fire_at", 64);
      const delay = args.delay_seconds === undefined ? undefined : Number(args.delay_seconds);
      if ((fireAt === undefined) === (delay === undefined)) throw new Error("reminder.schedule requires exactly one of fire_at or delay_seconds");
      if (fireAt && !Number.isFinite(Date.parse(fireAt))) throw new Error("reminder.schedule fire_at is invalid");
      if (delay !== undefined && (!Number.isInteger(delay) || delay < 1 || delay > 30 * 86_400)) throw new Error("reminder.schedule delay_seconds is invalid");
      effect = { id: "reminder.schedule", args: { title: text(args.title, "effect.args.title", 300), ...(fireAt ? { fire_at: fireAt } : {}), ...(delay !== undefined ? { delay_seconds: delay } : {}) } };
    }
    actions[actionId] = {
      from,
      label: text(action.label, `${actionId}.label`, 80),
      success_state: successState,
      failure_state: failureState,
      timeout_state: timeoutState,
      processing_state: processingState,
      agent: { instruction: text(agent.instruction, `${actionId}.agent.instruction`, 4_000), timeout_seconds: timeout },
      reflex: { toast: text(reflex.toast, `${actionId}.reflex.toast`, 180), ...(effect ? { effect } : {}) },
      result_schema: validateResultSchema(action.result_schema, actionId),
    };
  }
  for (const stateId of Object.keys(states)) {
    if (!states[stateId].terminal && !Object.values(actions).some((action) => action.from.includes(stateId) || action.processing_state === stateId)) {
      throw new Error(`non-terminal state ${stateId} has no action`);
    }
  }
  return { schema_version: 1, initial_state: initialState, expires_in_seconds: expires, transition_limit: transitionLimit, retention_seconds: retention, audience: { open_ids: openIds }, states, actions };
}

function renderCard(definition: InteractionDefinition, instance: InteractionInstance, refs: Map<string, string>, summary?: string): JsonObject {
  const view = instance.active_run_id
    ? { title: PROCESSING_TITLE, markdown: PROCESSING_MARKDOWN }
    : definition.states[instance.current_state];
  const elements: JsonObject[] = [{ tag: "markdown", content: `${view.markdown}${summary ? `\n\n${summary}` : ""}` }];
  if (!view.terminal && !instance.active_run_id) {
    const buttons = Object.entries(definition.actions)
      .filter(([, action]) => action.from.includes(instance.current_state))
      .map(([actionId, action], index, available) => ({
        tag: "button",
        text: { tag: "plain_text", content: action.label },
        type: index === 0 ? "primary_filled" : "default",
        ...(available.length === 1 ? { width: "fill" } : {}),
        behaviors: [{
          type: "callback",
          value: { interaction_ref: refs.get(actionId), interaction_version: instance.state_version },
        }],
      }));
    elements.push(...buttons);
  }
  return { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: view.title } }, body: { elements } };
}

function sameJson(left: unknown, right: unknown): boolean {
  const a = Buffer.from(JSON.stringify(left));
  const b = Buffer.from(JSON.stringify(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class InteractionStateMachine {
  private readonly now: () => number;
  private readonly randomId: (prefix: string) => string;

  constructor(private readonly options: { stateStore: AgentStateStore; agentId: string; now?: () => number; randomId?: (prefix: string) => string }) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
  }

  private pruneExpiredHistory(state: InteractionState): void {
    const now = this.now();
    const definitionById = new Map(state.definitions.map((item) => [item.definition_id, item]));
    const staleInstanceIds = new Set(
      state.instances
        .filter((instance) => {
          const definition = definitionById.get(instance.definition_id)?.spec;
          const retentionSeconds = Number(definition?.retention_seconds ?? 7 * 86_400);
          if (now < Date.parse(instance.expires_at) + retentionSeconds * 1_000 || instance.active_run_id) return false;
          const runIds = new Set(state.runs.filter((run) => run.instance_id === instance.instance_id).map((run) => run.run_id));
          return state.runs.filter((run) => runIds.has(run.run_id)).every((run) => run.resolve !== null)
            && state.outbox.filter((item) => runIds.has(item.run_id)).every((item) => item.status === "delivered");
        })
        .map((instance) => instance.instance_id),
    );
    if (staleInstanceIds.size === 0) return;

    const staleRunIds = new Set(state.runs.filter((run) => staleInstanceIds.has(run.instance_id)).map((run) => run.run_id));
    state.instances = state.instances.filter((instance) => !staleInstanceIds.has(instance.instance_id));
    state.runs = state.runs.filter((run) => !staleRunIds.has(run.run_id));
    state.action_refs = state.action_refs.filter((ref) => !staleInstanceIds.has(ref.instance_id));
    state.outbox = state.outbox.filter((item) => !staleRunIds.has(item.run_id));
    const referencedDefinitionIds = new Set(state.instances.map((instance) => instance.definition_id));
    state.definitions = state.definitions.filter((definition) => referencedDefinitionIds.has(definition.definition_id));
  }

  private enforceBounds(state: InteractionState): void {
    if (state.instances.length > MAX_INSTANCES) throw new Error(`interaction instance capacity ${MAX_INSTANCES} reached; wait for retention GC`);
    if (state.outbox.length > MAX_OUTBOX) {
      const removable = new Set(state.outbox.filter((item) => item.status === "delivered")
        .slice(0, state.outbox.length - MAX_OUTBOX).map((item) => item.outbox_id));
      state.outbox = state.outbox.filter((item) => !removable.has(item.outbox_id));
      if (state.outbox.length > MAX_OUTBOX) throw new Error(`interaction pending outbox capacity ${MAX_OUTBOX} reached`);
    }
    if (state.runs.length > MAX_RUNS) {
      const pendingRunIds = new Set(state.outbox.filter((item) => item.status !== "delivered").map((item) => item.run_id));
      const activeRunIds = new Set(state.instances.flatMap((instance) => instance.active_run_id ? [instance.active_run_id] : []));
      const removable = new Set(state.runs.filter((run) => run.resolve && !pendingRunIds.has(run.run_id) && !activeRunIds.has(run.run_id))
        .slice(0, state.runs.length - MAX_RUNS).map((run) => run.run_id));
      state.runs = state.runs.filter((run) => !removable.has(run.run_id));
      state.outbox = state.outbox.filter((item) => !removable.has(item.run_id));
      if (state.runs.length > MAX_RUNS) throw new Error(`interaction active run capacity ${MAX_RUNS} reached`);
    }
    const persistedBytes = Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`);
    if (persistedBytes > MAX_INTERACTION_STATE_BYTES) {
      throw new Error(`interaction state byte capacity ${MAX_INTERACTION_STATE_BYTES} reached; wait for retention GC`);
    }
  }

  private mutate<R>(operation: (state: InteractionState) => R): R {
    return this.options.stateStore.mutateJson("interactions", EMPTY_STATE(), (state) => {
      if (state.version !== 1 || !Array.isArray(state.definitions) || !Array.isArray(state.instances) || !Array.isArray(state.runs) || !Array.isArray(state.action_refs) || !Array.isArray(state.outbox)) throw new Error("interactions state is invalid");
      this.pruneExpiredHistory(state);
      const result = operation(state);
      this.enforceBounds(state);
      return result;
    });
  }

  snapshot(): InteractionState {
    return safeJson(this.options.stateStore.readJson("interactions", EMPTY_STATE()), "interaction state", MAX_INTERACTION_STATE_BYTES);
  }

  create(input: { definition: unknown; expected_chat_id: string }): { definition: InteractionDefinition; instance: InteractionInstance; card: JsonObject } {
    const definition = validateInteractionDefinition(input.definition);
    const chatId = text(input.expected_chat_id, "expected_chat_id", 160);
    if (!CHAT_ID.test(chatId)) throw new Error("expected_chat_id is invalid");
    return this.mutate((state) => {
      const now = this.now();
      const at = new Date(now).toISOString();
      const definitionId = this.randomId("def");
      const instanceId = this.randomId("int");
      const refs = new Map<string, string>();
      for (const actionId of Object.keys(definition.actions)) {
        const ref = this.randomId("ref");
        refs.set(actionId, ref);
        state.action_refs.push({ ref, instance_id: instanceId, action_id: actionId });
      }
      const instance: InteractionInstance = {
        instance_id: instanceId,
        definition_id: definitionId,
        owner_agent_id: this.options.agentId,
        expected_chat_id: chatId,
        message_id: null,
        current_state: definition.initial_state,
        state_version: 1,
        active_run_id: null,
        transition_count: 0,
        expires_at: new Date(now + definition.expires_in_seconds * 1_000).toISOString(),
        desired_projection_version: 1,
        projected_version: 0,
        created_at: at,
        updated_at: at,
      };
      state.definitions.push({ definition_id: definitionId, owner_agent_id: this.options.agentId, spec: definition, created_at: at });
      state.instances.push(instance);
      return { definition, instance: safeJson(instance, "instance"), card: renderCard(definition, instance, refs) };
    });
  }

  get(locator: { instance_id?: string; run_id?: string }): { definition: InteractionDefinition; instance: InteractionInstance; run?: InteractionRun; card: JsonObject } {
    const state = this.snapshot();
    const run = locator.run_id ? state.runs.find((item) => item.run_id === locator.run_id) : undefined;
    const instanceId = locator.instance_id || run?.instance_id;
    if (!instanceId) throw new Error("instance_id or run_id is required");
    const instance = state.instances.find((item) => item.instance_id === instanceId);
    if (!instance) throw new Error("interaction instance not found");
    const definition = state.definitions.find((item) => item.definition_id === instance.definition_id)?.spec;
    if (!definition) throw new Error("interaction definition not found");
    const refs = new Map(state.action_refs.filter((item) => item.instance_id === instanceId).map((item) => [item.action_id, item.ref]));
    return { definition, instance, ...(run ? { run } : {}), card: renderCard(definition, instance, refs, run?.resolve?.summary) };
  }

  claim(input: { interaction_ref: string; expected_version: number; callback_id: string; operator_open_id: string; chat_id: string; message_id: string }): { duplicate: boolean; definition: InteractionDefinition; instance: InteractionInstance; run: InteractionRun; card: JsonObject; toast: string } {
    return this.mutate((state) => {
      const prior = state.runs.find((item) => item.callback_id === input.callback_id);
      if (prior) {
        const instance = state.instances.find((item) => item.instance_id === prior.instance_id)!;
        const definition = state.definitions.find((item) => item.definition_id === instance.definition_id)!.spec;
        const refs = new Map(state.action_refs.filter((item) => item.instance_id === instance.instance_id).map((item) => [item.action_id, item.ref]));
        return { duplicate: true, definition, instance: safeJson(instance, "instance"), run: safeJson(prior, "run"), card: renderCard(definition, instance, refs, prior.resolve?.summary), toast: definition.actions[prior.action_id].reflex.toast };
      }
      const actionRef = state.action_refs.find((item) => item.ref === input.interaction_ref);
      if (!actionRef) throw new Error("interaction reference is invalid");
      const instance = state.instances.find((item) => item.instance_id === actionRef.instance_id);
      if (!instance) throw new Error("interaction instance not found");
      const definition = state.definitions.find((item) => item.definition_id === instance.definition_id)?.spec;
      if (!definition) throw new Error("interaction definition not found");
      const action = definition.actions[actionRef.action_id];
      const now = this.now();
      if (now >= Date.parse(instance.expires_at)) throw new Error("interaction has expired");
      if (instance.expected_chat_id !== input.chat_id) throw new Error("interaction chat is not allowed");
      if (!definition.audience.open_ids.includes(input.operator_open_id)) throw new Error("interaction operator is not allowed");
      if (instance.message_id && instance.message_id !== input.message_id) throw new Error("interaction card message is not allowed");
      if (instance.active_run_id) throw new Error("interaction already has an active run");
      if (!Number.isSafeInteger(input.expected_version) || input.expected_version !== instance.state_version) throw new Error("interaction card version is stale");
      if (!action.from.includes(instance.current_state)) throw new Error("interaction action is not allowed from current state");
      if (instance.transition_count >= Number(definition.transition_limit)) throw new Error("interaction transition limit reached");
      const at = new Date(now).toISOString();
      const runId = this.randomId("run");
      const sourceState = instance.current_state;
      const sourceVersion = instance.state_version;
      instance.message_id = input.message_id;
      instance.current_state = action.processing_state;
      instance.state_version += 1;
      instance.active_run_id = runId;
      instance.transition_count += 1;
      instance.desired_projection_version += 1;
      instance.updated_at = at;
      const run: InteractionRun = {
        run_id: runId,
        instance_id: instance.instance_id,
        action_id: actionRef.action_id,
        callback_id: text(input.callback_id, "callback_id", 300),
        operator_open_id: input.operator_open_id,
        chat_id: input.chat_id,
        message_id: input.message_id,
        source_state: sourceState,
        source_version: sourceVersion,
        expected_resolve_version: instance.state_version,
        callback_received_at: at,
        reflex_deadline_at: new Date(now + REFLEX_RECOVERY_MS).toISOString(),
        reflex_completed_at: null,
        agent_deadline_at: new Date(now + Number(action.agent.timeout_seconds) * 1_000).toISOString(),
        reflex: { status: "pending", summary: "", data: {} },
        agent_delivery_status: "pending",
        resolve: null,
        created_at: at,
        updated_at: at,
      };
      state.runs.push(run);
      state.outbox.push({ outbox_id: this.randomId("out"), kind: "card_projection", run_id: runId, status: "pending", payload: { instance_id: instance.instance_id, desired_version: instance.desired_projection_version }, created_at: at, updated_at: at, attempts: 0 });
      state.outbox.push({ outbox_id: this.randomId("out"), kind: "agent_wake", run_id: runId, status: "waiting_reflex", payload: {}, created_at: at, updated_at: at, attempts: 0 });
      const refs = new Map(state.action_refs.filter((item) => item.instance_id === instance.instance_id).map((item) => [item.action_id, item.ref]));
      return { duplicate: false, definition, instance: safeJson(instance, "instance"), run: safeJson(run, "run"), card: renderCard(definition, instance, refs), toast: action.reflex.toast };
    });
  }

  private finalizeReflex(state: InteractionState, run: InteractionRun, result: { status: Exclude<ReflexStatus, "pending">; summary: string; data?: JsonObject }): void {
    if (run.reflex.status !== "pending") return;
    const instance = state.instances.find((item) => item.instance_id === run.instance_id);
    const definition = instance && state.definitions.find((item) => item.definition_id === instance.definition_id)?.spec;
    const action = definition?.actions[run.action_id];
    const wake = state.outbox.find((item) => item.kind === "agent_wake" && item.run_id === run.run_id);
    if (!instance || !definition || !action || !wake) throw new Error("interaction Reflex recovery state is incomplete");
    const at = new Date(this.now()).toISOString();
    run.reflex = { status: result.status, summary: text(result.summary, "reflex summary", 1_000), data: safeJson(result.data ?? {}, "reflex data") };
    run.reflex_completed_at = at;
    run.updated_at = at;
    wake.status = "pending";
    wake.updated_at = at;
    wake.payload = {
      message_id: `interaction_${run.run_id}`,
      wake: true,
      kind: "interaction",
      sender_type: "human",
      sender_id: run.operator_open_id,
      chat_id: run.chat_id,
      card_message_id: run.message_id,
      interaction_instance_id: run.instance_id,
      interaction_run_id: run.run_id,
      action_id: run.action_id,
      source_state: run.source_state,
      source_version: run.source_version,
      expected_resolve_version: run.expected_resolve_version,
      agent_instruction: action.agent.instruction,
      reflex: run.reflex,
      side_effect_status: run.reflex.status,
      content: `Interactive card action requires Agent handling. Run interaction get --run-id ${run.run_id}, then interaction resolve --run-id ${run.run_id} --expected-version ${run.expected_resolve_version} --status <succeeded|failed> --summary <text>.`,
    };
  }

  recordReflex(runId: string, result: { status: Exclude<ReflexStatus, "pending">; summary: string; data?: JsonObject }): InteractionRun {
    return this.mutate((state) => {
      const run = state.runs.find((item) => item.run_id === runId);
      if (!run) throw new Error("interaction run not found");
      if (run.reflex.status !== "pending") return safeJson(run, "run");
      this.finalizeReflex(state, run, result);
      return safeJson(run, "run");
    });
  }

  recoverInterruptedReflexes(): number {
    return this.mutate((state) => {
      const now = this.now();
      let recovered = 0;
      for (const run of state.runs) {
        const deadline = Number.isFinite(Date.parse(run.reflex_deadline_at))
          ? Date.parse(run.reflex_deadline_at) : Date.parse(run.created_at) + REFLEX_RECOVERY_MS;
        if (run.reflex.status !== "pending" || now < deadline) continue;
        this.finalizeReflex(state, run, {
          status: "uncertain",
          summary: "Reflex execution was interrupted before its durable outcome was recorded; inspect before retrying.",
          data: { category: "reflex_interrupted" },
        });
        recovered += 1;
      }
      return recovered;
    });
  }

  resolve(input: { run_id: string; expected_version: number; status: ResolveStatus; summary: string; data?: JsonObject; agent_id: string }): { instance: InteractionInstance; run: InteractionRun; card: JsonObject; idempotent: boolean } {
    return this.mutate((state) => {
      const run = state.runs.find((item) => item.run_id === input.run_id);
      if (!run) throw new Error("interaction run not found");
      const instance = state.instances.find((item) => item.instance_id === run.instance_id)!;
      const definition = state.definitions.find((item) => item.definition_id === instance.definition_id)!.spec;
      const summary = text(input.summary, "resolve summary", 1_000);
      const action = definition.actions[run.action_id];
      const data = validateResultData(action.result_schema, input.data ?? {});
      if (run.resolve) {
        if (run.resolve.status === input.status && run.resolve.summary === summary && sameJson(run.resolve.data, data)) {
          const refs = new Map(state.action_refs.filter((item) => item.instance_id === instance.instance_id).map((item) => [item.action_id, item.ref]));
          return { instance: safeJson(instance, "instance"), run: safeJson(run, "run"), card: renderCard(definition, instance, refs, summary), idempotent: true };
        }
        throw new Error("interaction run is already terminal");
      }
      if (input.expected_version !== instance.state_version || input.expected_version !== run.expected_resolve_version) throw new Error("interaction version conflict");
      if (input.agent_id !== instance.owner_agent_id) throw new Error("interaction owner mismatch");
      if (instance.active_run_id !== run.run_id) throw new Error("interaction run is not active");
      if (this.now() >= Date.parse(instance.expires_at)) throw new Error("interaction has expired; wait for timeout recovery instead of resolving it");
      const at = new Date(this.now()).toISOString();
      instance.current_state = input.status === "succeeded" ? action.success_state : action.failure_state;
      instance.state_version += 1;
      instance.active_run_id = null;
      instance.desired_projection_version += 1;
      instance.updated_at = at;
      run.resolve = { status: input.status, summary, data, resolved_at: at };
      run.updated_at = at;
      state.outbox.push({ outbox_id: this.randomId("out"), kind: "card_projection", run_id: run.run_id, status: "pending", payload: { instance_id: instance.instance_id, desired_version: instance.desired_projection_version }, created_at: at, updated_at: at, attempts: 0 });
      const refs = new Map(state.action_refs.filter((item) => item.instance_id === instance.instance_id).map((item) => [item.action_id, item.ref]));
      return { instance: safeJson(instance, "instance"), run: safeJson(run, "run"), card: renderCard(definition, instance, refs, summary), idempotent: false };
    });
  }

  expireTimedOutRuns(): number {
    return this.mutate((state) => {
      const now = this.now();
      const at = new Date(now).toISOString();
      let count = 0;
      for (const run of state.runs) {
        const instance = state.instances.find((item) => item.instance_id === run.instance_id);
        if (!instance || instance.active_run_id !== run.run_id) continue;
        const instanceExpired = now >= Date.parse(instance.expires_at);
        if (run.resolve || (!instanceExpired && now < Date.parse(run.agent_deadline_at))) continue;
        const definition = state.definitions.find((item) => item.definition_id === instance.definition_id)?.spec;
        const action = definition?.actions[run.action_id];
        if (!definition || !action) continue;
        instance.current_state = action.timeout_state;
        instance.state_version += 1;
        instance.active_run_id = null;
        instance.desired_projection_version += 1;
        instance.updated_at = at;
        run.resolve = { status: "timed_out", summary: instanceExpired
          ? "Interaction expired before the Agent resolved it."
          : "Agent did not resolve before the declared deadline.", data: {}, resolved_at: at };
        run.updated_at = at;
        state.outbox.push({ outbox_id: this.randomId("out"), kind: "card_projection", run_id: run.run_id, status: "pending", payload: { instance_id: instance.instance_id, desired_version: instance.desired_projection_version }, created_at: at, updated_at: at, attempts: 0 });
        count += 1;
      }
      return count;
    });
  }

  pendingMaintenance(): { interrupted_reflex: boolean; timed_out_run: boolean } {
    const observedAt = this.now();
    const observed = this.snapshot();
    const interruptedReflex = observed.runs.some((run) => {
      const deadline = Number.isFinite(Date.parse(run.reflex_deadline_at))
        ? Date.parse(run.reflex_deadline_at) : Date.parse(run.created_at) + REFLEX_RECOVERY_MS;
      return run.reflex.status === "pending" && observedAt >= deadline;
    });
    const timedOutRun = observed.runs.some((run) => {
      if (run.resolve) return false;
      const instance = observed.instances.find((item) => item.instance_id === run.instance_id);
      return instance?.active_run_id === run.run_id
        && (observedAt >= Date.parse(run.agent_deadline_at) || observedAt >= Date.parse(instance.expires_at));
    });
    return { interrupted_reflex: interruptedReflex, timed_out_run: timedOutRun };
  }

  pendingOutbox(kind?: InteractionOutbox["kind"]): InteractionOutbox[] {
    return this.snapshot().outbox.filter((item) => item.status === "pending" && (!kind || item.kind === kind));
  }

  prepareProjection(outboxId: string): null | { message_id: string; desired_version: number; card: JsonObject } {
    return this.mutate((state) => {
      const item = state.outbox.find((candidate) => candidate.outbox_id === outboxId);
      if (!item || item.kind !== "card_projection" || item.status !== "pending") return null;
      const instanceId = String(item.payload.instance_id || "");
      const desiredVersion = Number(item.payload.desired_version);
      const instance = state.instances.find((candidate) => candidate.instance_id === instanceId);
      if (!instance) throw new Error("card projection instance not found");
      if (desiredVersion !== instance.desired_projection_version || desiredVersion <= instance.projected_version) {
        item.status = "delivered";
        item.updated_at = new Date(this.now()).toISOString();
        item.last_error = "superseded before delivery";
        return null;
      }
      if (!instance.message_id) throw new Error("card message is not bound");
      const definition = state.definitions.find((candidate) => candidate.definition_id === instance.definition_id)?.spec;
      if (!definition) throw new Error("card projection definition not found");
      const refs = new Map(state.action_refs.filter((ref) => ref.instance_id === instance.instance_id).map((ref) => [ref.action_id, ref.ref]));
      const run = state.runs.find((candidate) => candidate.run_id === item.run_id);
      return { message_id: instance.message_id, desired_version: desiredVersion, card: renderCard(definition, instance, refs, run?.resolve?.summary) };
    });
  }

  completeProjection(outboxId: string, expectedVersion: number, result: { delivered: boolean; error?: string }): void {
    this.mutate((state) => {
      const item = state.outbox.find((candidate) => candidate.outbox_id === outboxId);
      if (!item || item.kind !== "card_projection") throw new Error("card projection outbox item not found");
      item.attempts += 1;
      item.updated_at = new Date(this.now()).toISOString();
      if (!result.delivered) {
        item.status = "pending";
        item.last_error = text(result.error || "delivery failed", "outbox error", 500);
        return;
      }
      item.status = "delivered";
      const instance = state.instances.find((candidate) => candidate.instance_id === String(item.payload.instance_id || ""));
      if (!instance) return;
      if (instance.desired_projection_version === expectedVersion) {
        instance.projected_version = expectedVersion;
        item.last_error = null;
      } else {
        item.last_error = "superseded after delivery; newer projection remains pending";
      }
    });
  }

  markOutbox(outboxId: string, result: { delivered: boolean; error?: string }): void {
    this.mutate((state) => {
      const item = state.outbox.find((candidate) => candidate.outbox_id === outboxId);
      if (!item) throw new Error("interaction outbox item not found");
      item.attempts += 1;
      item.updated_at = new Date(this.now()).toISOString();
      item.status = result.delivered ? "delivered" : "pending";
      item.last_error = result.delivered ? null : text(result.error || "delivery failed", "outbox error", 500);
      if (result.delivered && item.kind === "agent_wake") {
        const run = state.runs.find((candidate) => candidate.run_id === item.run_id);
        if (run) run.agent_delivery_status = "delivered";
      }
      if (item.kind === "card_projection") throw new Error("card projections require completeProjection with an exact version fence");
    });
  }
}
