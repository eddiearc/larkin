import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const { traceProcessBoundary } = await import(pathToFileURL(path.join(ROOT, "dist/platform/process-boundary-trace.mjs")).href);

test("process-boundary trace contains only normalized path roles and fixed error categories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-trace-privacy-"));
  const config = path.join(root, "private-config");
  const target = path.join(config, "providers", "pi", "cli_privateAgent");
  const trace = path.join(root, "trace.ndjson");
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(trace, "", { mode: 0o600 });
  const rawError = `ENOENT ${target}/models.json secret=fixture-private-error`;
  traceProcessBoundary({
    LARKIN_PROCESS_BOUNDARY_TRACE_FILE: trace,
    LARKIN_CONFIG_DIR: config,
    LARKIN_HOME: path.join(root, "private-home"),
    PI_CODING_AGENT_DIR: path.join(root, "private-profile"),
    LARKIN_DAEMON_EPOCH: "2026-08-16T21:41:40.000Z",
  }, "test:privacy", {
    configDir: config,
    targetDir: target,
    agentId: "cli_privateAgent",
    childPid: 1234,
    error: Object.assign(new Error(rawError), { code: "ENOENT" }),
  });
  const record = JSON.parse(fs.readFileSync(trace, "utf8"));
  const serialized = JSON.stringify(record);
  for (const secret of [root, config, target, rawError, "private-home", "private-profile", "models.json"]) {
    assert.equal(serialized.includes(secret), false, `trace leaked ${secret}`);
  }
  assert.deepEqual(record.pathRoles.map((role) => role.role), ["config-root", "provider-target"]);
  assert.equal(record.pathRoles.every((role) => role.exists === true && role.directory === true && role.mode === 0o700), true);
  assert.equal(record.errorCategory, "missing");
  assert.equal(record.pid > 0, true);
  assert.equal(record.ppid > 0, true);
  assert.equal(record.epoch, "2026-08-16T21:41:40.000Z");
});
