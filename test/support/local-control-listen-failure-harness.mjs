import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import {
  createSupervisorControlServer,
  initializeControlAuthority,
  removeControlAuthority,
} from "../../dist/app/local-control.mjs";
import { currentProcessMetadata } from "../../dist/platform/process-state.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
if (!root) throw new Error("LARKIN_CONFIG_DIR missing");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
fs.chmodSync(root, 0o700);
const supervisor = currentProcessMetadata("test/support/local-control-listen-failure-harness.mjs");
fs.writeFileSync(path.join(root, "supervisor-status.json"), JSON.stringify(supervisor), { mode: 0o600 });
const token = initializeControlAuthority(root, {
  pid: process.pid,
  processStartToken: supervisor.processStartToken,
});
const authority = JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8"));
const server = createSupervisorControlServer({ larkinHome: root, authorityToken: token, ensureDashboard: () => "ready" });
const replacementMode = process.env.LARKIN_REPLACE_BEFORE_CHMOD === "1"
  || process.env.LARKIN_REPLACE_BEFORE_LISTEN === "1";
await assert.rejects(server.start(), process.env.LARKIN_REPLACE_BEFORE_LISTEN === "1"
  ? (error) => error?.code === "EADDRINUSE"
  : /fixture chmod failure/);
if (replacementMode) {
  assert.equal(fs.lstatSync(authority.supervisorSocketPath).isSocket(), true);
  const connect = () => new Promise((resolve, reject) => {
    const client = net.createConnection(authority.supervisorSocketPath);
    let output = "";
    client.setEncoding("utf8");
    client.once("error", reject);
    client.on("data", (chunk) => { output += chunk; });
    client.once("end", () => resolve(output));
  });
  const deadline = Date.now() + 3_000;
  let response;
  while (response === undefined) {
    try {
      response = await connect();
    } catch (error) {
      if (error?.code !== "ECONNREFUSED" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(response, "replacement");
  const replacement = globalThis.__larkinReplacementChild;
  assert.ok(replacement);
  replacement.kill("SIGTERM");
  await once(replacement, "exit");
} else {
  assert.equal(fs.existsSync(authority.supervisorSocketPath), false);
  assert.equal(fs.existsSync(authority.socketRoot), false);
}
await server.close();
assert.equal(fs.existsSync(authority.supervisorSocketPath), false);
assert.equal(fs.existsSync(authority.socketRoot), false);
removeControlAuthority(root, token);
console.log("listen-failure-clean");
