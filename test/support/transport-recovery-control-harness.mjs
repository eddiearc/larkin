import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAgentControlServer, initializeControlAuthority } from "../../dist/app/local-control.mjs";
import { inspectProcess } from "../../dist/platform/process-state.mjs";
import { createTransportFixture, fixtureAgentId } from "./transport-recovery-fixture.mjs";
const root = process.env.LARKIN_CONFIG_DIR;
const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "app/run.mjs"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 150));
const inspected = inspectProcess(supervisor.pid);
if (!inspected.ok || !inspected.startToken) throw new Error("supervisor unavailable");
fs.writeFileSync(path.join(root, "supervisor-status.json"), JSON.stringify({ pid: supervisor.pid, commandToken: "app/run.mjs", processStartToken: inspected.startToken, nonce: "transport-test" }), { mode: 0o600 });
const authorityToken = initializeControlAuthority(root, { pid: supervisor.pid, processStartToken: inspected.startToken });
const fixture = await createTransportFixture(root, {
  now: () => Number(fs.readFileSync(path.join(root, "clock"), "utf8")),
  onPrompt(input) { fs.appendFileSync(path.join(root, "inputs.ndjson"), JSON.stringify(input) + "\n"); },
});
const failureCount = Number(process.env.LARKIN_TRANSPORT_FAILURE_COUNT || 1);
if (!fixture.store.readJson("runtimeDeliveries", { records: [] }).records.length) {
  await fixture.fail();
  for (let index = 1; index < failureCount; index++) await fixture.fail({ direct: true, messageId: `om_transport_failed_${index}` });
}
const server = createAgentControlServer({ larkinHome: root, authorityToken,
  async upsert() { throw new Error("unsupported"); },
  recoverTransportSession(request) { return fixture.host().recoverTransportSession(request.agentId, request); },
});
await server.start();
let finishing = false;
const timer = setInterval(async () => {
  const marker = path.join(root, "finish");
  if (finishing || !fs.existsSync(marker)) return;
  finishing = true; fs.unlinkSync(marker);
  try { await fixture.finish({ limit: failureCount }); fs.writeFileSync(path.join(root, "finished"), "yes"); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { finishing = false; }
}, 20);
console.log("ready");
async function stop() { clearInterval(timer); await server.close(); await fixture.close(); supervisor.kill("SIGTERM"); process.exit(0); }
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
