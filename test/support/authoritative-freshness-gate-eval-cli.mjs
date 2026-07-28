import fs from "node:fs";

const traceFile = process.env.LARKIN_EVAL_TRACE_FILE;
if (!traceFile) throw new Error("LARKIN_EVAL_TRACE_FILE is required");
const argv = process.argv.slice(2);
const append = (event) => fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
const textAt = argv.findIndex((part) => part === "--text" || part === "--markdown");
const text = textAt >= 0 ? argv[textAt + 1] || "" : "";

if (argv[0] === "larkin-draft") {
  append({ action: "draft", argv });
  process.exit(2);
}
if (process.env.LARKIN_EVAL_SURFACE !== "lark-cli" || argv[0] !== "im"
    || !["+messages-send", "+messages-reply"].includes(argv[1])) {
  append({ action: "unexpected_command", argv });
  process.stderr.write("only the instructed ordinary write command is available\n");
  process.exit(2);
}
const previous = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
if (!previous.some((event) => event.action === "write_attempt")) {
  append({ action: "write_attempt", exit_code: 3, subtype: "freshness_conflict", provider_reached: false, intent: "stale", text });
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { type: "conflict", subtype: "freshness_conflict" },
    target: "feishu.im/chat/oc_eval_freshness",
    unseen_messages: [{ message_id: "om_eval_update", chat_id: "oc_eval_freshness", create_time: "1900", body: { content: "{\"text\":\"Use the new green status and explicitly replace the stale red status.\"}" } }],
    next: "Reconsider this context and retry an ordinary send command.",
  })}\n`);
  process.exit(3);
}
append({ action: "provider_write", command: argv[1], intent: /green|replace|revised|updated/i.test(text) ? "revised" : "unchanged", text });
process.stdout.write('{"ok":true,"data":{"message_id":"om_eval_sent","chat_id":"oc_eval_freshness","create_time":"1901"}}\n');
