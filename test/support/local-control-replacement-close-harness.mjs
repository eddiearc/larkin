import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  createAgentControlServer,
  createSupervisorControlServer,
  initializeControlAuthority,
  removeControlAuthority,
} from "../../dist/app/local-control.mjs";
import { currentProcessMetadata } from "../../dist/platform/process-state.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
if (!root) throw new Error("LARKIN_CONFIG_DIR missing");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const processRecord = currentProcessMetadata("test/support/local-control-replacement-close-harness.mjs");
fs.writeFileSync(path.join(root, "supervisor-status.json"), JSON.stringify(processRecord), { mode: 0o600 });
fs.writeFileSync(path.join(root, "daemon-status.json"), JSON.stringify({ ...processRecord, agents: [] }), { mode: 0o600 });
const token = initializeControlAuthority(root, {
  pid: process.pid,
  processStartToken: processRecord.processStartToken,
});
const supervisor = createSupervisorControlServer({ larkinHome: root, authorityToken: token, ensureDashboard: () => "ready" });
const daemon = createAgentControlServer({ larkinHome: root, authorityToken: token, async upsert() {} });
await supervisor.start();
await daemon.start();
const authority = JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8"));

const listenReplacement = async (socket) => {
  fs.unlinkSync(socket);
  const server = net.createServer((connection) => connection.end("replacement"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => { server.off("error", reject); resolve(); });
  });
  return server;
};
const connect = async (socket) => await new Promise((resolve, reject) => {
  const client = net.createConnection(socket);
  let output = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  client.on("data", (chunk) => { output += chunk; });
  client.once("end", () => resolve(output));
});
const close = async (server) => await new Promise((resolve) => server.close(resolve));

const daemonReplacement = await listenReplacement(authority.daemonSocketPath);
const supervisorReplacement = await listenReplacement(authority.supervisorSocketPath);
try {
  await daemon.close();
  assert.equal(fs.lstatSync(authority.daemonSocketPath).isSocket(), true);
  assert.equal(await connect(authority.daemonSocketPath), "replacement");
  await supervisor.close();
  assert.equal(fs.lstatSync(authority.supervisorSocketPath).isSocket(), true);
  assert.equal(await connect(authority.supervisorSocketPath), "replacement");
} finally {
  await close(daemonReplacement);
  await close(supervisorReplacement);
  removeControlAuthority(root, token);
}
assert.equal(fs.existsSync(authority.socketRoot), false);
console.log("replacement-close-preserved");
