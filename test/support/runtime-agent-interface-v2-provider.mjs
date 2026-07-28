import fs from "node:fs";

const argv = process.argv.slice(2);
const callsFile = process.env.LARKIN_TEST_PROVIDER_CALLS;
if (!callsFile) throw new Error("LARKIN_TEST_PROVIDER_CALLS is required");

const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
};

const isHistoryRead = argv[0] === "im"
  && (argv[1] === "+chat-messages-list" || argv[1] === "+threads-messages-list")
  || (argv[0] === "api" && argv[1] === "GET" && argv[2] === "/open-apis/im/v1/messages");

fs.appendFileSync(callsFile, `${JSON.stringify({
  argv,
  as: valueAfter("--as"),
  idempotency_key: valueAfter("--idempotency-key"),
  config_dir: process.env.LARKSUITE_CLI_CONFIG_DIR || null,
})}\n`, { mode: 0o600 });

const historyCallIndex = isHistoryRead
  ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    .filter((call) => ["+chat-messages-list", "+threads-messages-list"].includes(call.argv?.[1])
      || (call.argv?.[0] === "api" && call.argv?.[1] === "GET" && call.argv?.[2] === "/open-apis/im/v1/messages")).length - 1
  : -1;
const historySequence = process.env.LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE
  ? JSON.parse(process.env.LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE) : null;
const sequencedHistory = isHistoryRead && Array.isArray(historySequence) ? historySequence[historyCallIndex] : undefined;

if (process.env.LARKIN_TEST_PROVIDER_APPEND_FILE && process.env.LARKIN_TEST_PROVIDER_APPEND_ENVELOPE) {
  fs.appendFileSync(
    process.env.LARKIN_TEST_PROVIDER_APPEND_FILE,
    `${process.env.LARKIN_TEST_PROVIDER_APPEND_ENVELOPE}\n`,
    { mode: 0o600 },
  );
}

if (!isHistoryRead && process.env.LARKIN_TEST_PROVIDER_WRITE_MODE === "kill-parent") {
  const parentPid = Number(process.env.LARKIN_TEST_PROVIDER_PARENT_PID);
  if (!Number.isSafeInteger(parentPid) || parentPid < 2) throw new Error("provider parent PID is invalid");
  process.kill(parentPid, "SIGKILL");
}
if (!isHistoryRead && process.env.LARKIN_TEST_PROVIDER_WRITE_MODE === "fail") {
  process.stderr.write("fixture provider write failure\n");
  process.exit(Number(process.env.LARKIN_TEST_PROVIDER_EXIT_CODE || 7));
}

switch (process.env.LARKIN_TEST_PROVIDER_MODE || "success") {
  case "success":
    if (isHistoryRead && sequencedHistory && typeof sequencedHistory === "object" && sequencedHistory.exit_code) {
      process.stderr.write(sequencedHistory.stderr || "fixture sequenced provider failure\n");
      process.exit(Number(sequencedHistory.exit_code));
    } else if (isHistoryRead && sequencedHistory !== undefined) {
      process.stdout.write(typeof sequencedHistory === "string" ? sequencedHistory : JSON.stringify(sequencedHistory));
    } else if (isHistoryRead && process.env.LARKIN_TEST_PROVIDER_HISTORY !== undefined) {
      process.stdout.write(process.env.LARKIN_TEST_PROVIDER_HISTORY);
    } else if (!isHistoryRead && process.env.LARKIN_TEST_PROVIDER_WRITE_STDOUT !== undefined) process.stdout.write(process.env.LARKIN_TEST_PROVIDER_WRITE_STDOUT);
    else if (process.env.LARKIN_TEST_PROVIDER_STDOUT !== undefined) process.stdout.write(process.env.LARKIN_TEST_PROVIDER_STDOUT);
    else process.stdout.write('{"ok":true}\n');
    if (process.env.LARKIN_TEST_PROVIDER_STDERR) process.stderr.write(process.env.LARKIN_TEST_PROVIDER_STDERR);
    break;
  case "fail":
    process.stderr.write(process.env.LARKIN_TEST_PROVIDER_STDERR || "fixture provider failure\n");
    process.exit(Number(process.env.LARKIN_TEST_PROVIDER_EXIT_CODE || 7));
    break;
  case "kill-parent": {
    const parentPid = Number(process.env.LARKIN_TEST_PROVIDER_PARENT_PID);
    if (!Number.isSafeInteger(parentPid) || parentPid < 2) throw new Error("provider parent PID is invalid");
    process.kill(parentPid, "SIGKILL");
    break;
  }
  default:
    throw new Error(`unknown provider mode: ${process.env.LARKIN_TEST_PROVIDER_MODE}`);
}
