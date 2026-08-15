import fs from "node:fs";

const traceFile = process.env.CLICKABLE_EVAL_TRACE_FILE;
if (!traceFile) throw new Error("CLICKABLE_EVAL_TRACE_FILE is required");
const argv = process.argv.slice(2);
const surface = process.env.CLICKABLE_EVAL_SURFACE || "unknown";
const append = (event) => fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
const indexes = (flag) => argv.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
const valueAt = (flag) => {
  const found = indexes(flag);
  return found.length === 1 ? argv[found[0] + 1] ?? "" : "";
};

const command = argv[1];
const operation = command === "+messages-send" ? "send" : command === "+messages-reply" ? "reply" : null;
if (argv[0] !== "im" || operation === null) {
  append({ action: "eval_rejection", argv, error: "unsupported command" });
  process.stderr.write("clickable-link eval exposes only synthetic send/reply commands\n");
  process.exit(2);
}

const targetFlag = operation === "send" ? "--chat-id" : "--message-id";
const bodyFlags = ["--text", "--markdown", "--content"];
const presentBodyFlags = bodyFlags.flatMap((flag) => indexes(flag).map(() => flag));
const bodyFlag = presentBodyFlags.length === 1 ? presentBodyFlags[0] : "";
const target = valueAt(targetFlag);
const body = bodyFlag ? valueAt(bodyFlag) : "";
const expectedTarget = operation === "send" ? "oc_eval_clickable" : "om_eval_clickable_exact";
const valid = surface === "larkin"
  && indexes(targetFlag).length === 1
  && target === expectedTarget
  && presentBodyFlags.length === 1
  && body.length > 0;
const error = valid ? null : "fake sink rejected surface, target, or body flags";
const messageId = valid ? (operation === "send" ? "om_eval_clickable_sent" : "om_eval_clickable_replied") : null;
append({
  schema_version: 1,
  action: "provider_write",
  surface,
  operation,
  target_flag: targetFlag,
  target,
  body_flag: bodyFlag,
  body,
  argv,
  success: valid,
  message_id: messageId,
  error,
});
if (!valid) {
  process.stderr.write(`${error}\n`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({ ok: true, data: { message_id: messageId, synthetic: true } })}\n`);
