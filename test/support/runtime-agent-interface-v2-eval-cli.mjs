import fs from "node:fs";

const surface = process.env.LARKIN_EVAL_SURFACE;
const stateFile = process.env.LARKIN_EVAL_STATE_FILE;
const traceFile = process.env.LARKIN_EVAL_TRACE_FILE;
if (!surface || !stateFile || !traceFile) throw new Error("runtime interface eval CLI is missing its isolated control files");

const argv = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) => fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
const append = (event) => fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
const value = (flag) => {
  const index = argv.indexOf(flag);
  return index < 0 ? null : argv[index + 1] || null;
};
const output = (body) => process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);

if (argv.includes("--help") || argv.includes("-h")) {
  output(surface === "larkin"
    ? { usage: ["larkin inbox check [--target <target>]", "larkin inbox poll [--target <target>]"] }
    : { usage: ["lark-cli im +messages-send --chat-id <chat-id> --markdown <message>", "lark-cli larkin-draft send --draft-id <id>"] });
  process.exit(0);
}

const state = readState();
const targetState = (target) => state.targets[target] ??= { latest: 0, seen: 0 };

if (surface === "larkin" && argv[0] === "inbox" && argv[1] === "check") {
  const only = value("--target");
  const targets = Object.entries(state.targets).filter(([target, row]) => (!only || only === target) && row.latest > row.seen)
    .map(([target, row]) => ({ target, pending_count: row.latest - row.seen, latest_received_seq: row.latest }));
  append({ action: "check", ...(only ? { target: only } : {}), content_observed: false });
  output({ version: 2, targets, pending_total: targets.reduce((count, row) => count + row.pending_count, 0), has_more: false });
  process.exit(0);
}

if (surface === "larkin" && argv[0] === "inbox" && argv[1] === "poll") {
  const target = value("--target");
  if (!target || !state.targets[target]) {
    process.stderr.write("eval larkin: poll requires an exact known --target\n");
    process.exit(2);
  }
  const row = targetState(target);
  row.seen = row.latest;
  append({ action: "poll", target, seq: row.seen, direct_ack: true });
  const events = row.seen ? [{ envelope_version: 2, target, target_seq: row.seen, message_id: `om_eval_${row.seen}`, content: `controlled message ${row.seen}` }] : [];
  output({ version: 2, delivery: "direct_ack", at_most_once: true, events, seen_through_seq: row.seen });
  if (state.inject_after_poll?.target === target && !state.inject_after_poll.done) {
    row.latest = state.inject_after_poll.seq;
    state.inject_after_poll.done = true;
    append({ action: "update", target, seq: row.latest });
  }
  writeState(state);
  process.exit(0);
}

if (surface === "lark-cli" && argv[0] === "im" && argv[1] === "+messages-send") {
  const chatId = value("--chat-id");
  const target = chatId ? `chat:${chatId}` : null;
  if (!target || !state.targets[target]) {
    process.stderr.write("eval lark-cli: send requires an exact known --chat-id\n");
    process.exit(2);
  }
  const row = targetState(target);
  if (row.latest > row.seen) {
    const draftId = `draft_eval_${state.scenario_id}`;
    state.drafts[draftId] = { target, argv };
    append({ action: "write_attempt", target, based_on_seq: row.seen, outcome: "held", provider_reached: false });
    writeState(state);
    output({ ok: false, status: "held", target, latest_received_seq: row.latest, model_seen_seq: row.seen, draft_id: draftId,
      next: `larkin inbox poll --target ${target}` });
    process.exit(0);
  }
  append({ action: "provider_write", target, based_on_seq: row.seen, intent: state.drafts_sent ? "revised" : "current" });
  output({ ok: true, identity: "bot", provider_calls: 1 });
  process.exit(0);
}

if (surface === "lark-cli" && argv[0] === "larkin-draft" && argv[1] === "send") {
  const draftId = value("--draft-id");
  const draft = state.drafts[draftId];
  if (!draft) {
    process.stderr.write("eval lark-cli: held draft not found\n");
    process.exit(2);
  }
  const row = targetState(draft.target);
  if (row.latest > row.seen) {
    append({ action: "write_attempt", target: draft.target, based_on_seq: row.seen, outcome: "held", provider_reached: false });
    output({ ok: false, status: "held", target: draft.target, draft_id: draftId });
    process.exit(0);
  }
  state.drafts_sent = true;
  writeState(state);
  append({ action: "provider_write", target: draft.target, based_on_seq: row.seen, intent: "revised" });
  output({ ok: true, identity: "bot", provider_calls: 1 });
  process.exit(0);
}

if (surface === "lark-cli" && argv[0] === "larkin-draft" && argv[1] === "abandon") {
  const draftId = value("--draft-id");
  delete state.drafts[draftId];
  writeState(state);
  output({ ok: true, status: "abandoned", draft_id: draftId });
  process.exit(0);
}

process.stderr.write(`eval ${surface}: unsupported controlled command\n`);
process.exit(2);
