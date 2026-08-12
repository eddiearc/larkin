import fs from "node:fs";

const traceFile = process.env.LARKIN_EVAL_TRACE_FILE;
if (!traceFile) throw new Error("LARKIN_EVAL_TRACE_FILE is required");
const argv = process.argv.slice(2);
const append = (event) => fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
const extract = (flag) => {
  const index = argv.findIndex((part) => part === flag);
  return index >= 0 ? argv[index + 1] || "" : null;
};
const command = ["larkin", ...argv].join(" ");

if (process.env.LARKIN_EVAL_SURFACE !== "lark-cli" || argv[0] !== "im"
    || !["+messages-send", "+messages-reply"].includes(argv[1])) {
  append({ action: "tool", command, exit_code: 2, unexpected: true });
  process.stderr.write("only the instructed send/reply write is available in this eval\n");
  process.exit(2);
}
const content = extract("--content");
const text = extract("--text") ?? extract("--markdown");
append({
  action: "provider_write",
  command,
  chat_id: extract("--chat-id") ?? extract("--message-id"),
  content,
  text,
  msg_type: extract("--msg-type"),
  exit_code: 0,
});
process.stdout.write('{"ok":true,"data":{"message_id":"om_eval_mention_sent","chat_id":"oc_eval_partner_group","create_time":"1901"}}\n');
