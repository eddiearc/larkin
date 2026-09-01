import fs from "node:fs";

const traceFile = process.env.INBOX_AUDIT_ROUTING_TRACE_FILE;
const expectedAnchor = process.env.INBOX_AUDIT_ROUTING_ANCHOR;
if (!traceFile || !expectedAnchor) throw new Error("inbox audit routing sink requires trace file and anchor");

const argv = process.argv.slice(2);
const indexes = (flag) => argv.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
const valueAt = (flag) => {
  const found = indexes(flag);
  return found.length === 1 ? argv[found[0] + 1] || "" : "";
};
const bodyFlags = ["--markdown", "--text"];
const presentBodyFlags = bodyFlags.filter((flag) => indexes(flag).length === 1);
const bodyFlag = presentBodyFlags.length === 1 ? presentBodyFlags[0] : "";
const body = bodyFlag ? valueAt(bodyFlag) : "";
const valid = argv[0] === "im"
  && argv[1] === "+messages-reply"
  && indexes("--message-id").length === 1
  && valueAt("--message-id") === expectedAnchor
  && indexes("--reply-in-thread").length === 1
  && indexes("--json").length === 1
  && body.length > 0;
const event = {
  action: "provider_write",
  target: valueAt("--message-id"),
  argv,
  success: valid,
};
fs.appendFileSync(traceFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
if (!valid) {
  process.stderr.write("controlled inbox audit sink rejected write\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({ ok: true, data: { message_id: "om_audit_reply" } })}\n`);
