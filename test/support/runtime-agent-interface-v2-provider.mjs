import fs from "node:fs";

const argv = process.argv.slice(2);
const callsFile = process.env.LARKIN_TEST_PROVIDER_CALLS;
if (!callsFile) throw new Error("LARKIN_TEST_PROVIDER_CALLS is required");

const valueAfter = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
};

fs.appendFileSync(callsFile, `${JSON.stringify({
  argv,
  as: valueAfter("--as"),
  idempotency_key: valueAfter("--idempotency-key"),
  config_dir: process.env.LARKSUITE_CLI_CONFIG_DIR || null,
})}\n`, { mode: 0o600 });

if (process.env.LARKIN_TEST_PROVIDER_APPEND_FILE && process.env.LARKIN_TEST_PROVIDER_APPEND_ENVELOPE) {
  fs.appendFileSync(
    process.env.LARKIN_TEST_PROVIDER_APPEND_FILE,
    `${process.env.LARKIN_TEST_PROVIDER_APPEND_ENVELOPE}\n`,
    { mode: 0o600 },
  );
}

switch (process.env.LARKIN_TEST_PROVIDER_MODE || "success") {
  case "success":
    if (process.env.LARKIN_TEST_PROVIDER_STDOUT !== undefined) process.stdout.write(process.env.LARKIN_TEST_PROVIDER_STDOUT);
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
