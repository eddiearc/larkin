import fs from "node:fs";
import path from "node:path";
import { createAgentControlServer } from "../../dist/app/local-control.mjs";
import { loadConfig, markConfigApplied, runtimeConfigSignature } from "../../dist/platform/config.mjs";
import { currentProcessMetadata } from "../../dist/platform/process-state.mjs";

const root = process.env.LARKIN_CONFIG_DIR;
if (!root) throw new Error("LARKIN_CONFIG_DIR missing");
const statusFile = path.join(root, "daemon-status.json");
let agents = JSON.parse(process.env.LARKIN_AGENTS_CONFIG || "[]").map((agent) => agent.agentId);

function writeStatus() {
  fs.writeFileSync(statusFile, `${JSON.stringify({
    ...currentProcessMetadata("supervisor-hot-attach-daemon.mjs"),
    pid: process.pid,
    commandToken: "supervisor-hot-attach-daemon.mjs",
    agents,
    connectedAgents: [...agents],
  }, null, 2)}\n`, { mode: 0o600 });
}

const control = createAgentControlServer({
  larkinHome: root,
  authorityToken: process.env.LARKIN_CONTROL_AUTHORIZATION,
  async upsert({ agentId }) {
    const loaded = loadConfig(process.env);
    if (!loaded.config.agents[agentId]) throw new Error(`Agent ${agentId} missing from durable config`);
    if (!agents.includes(agentId)) agents.push(agentId);
    markConfigApplied(process.env, agentId, runtimeConfigSignature(loaded.config, agentId));
    writeStatus();
  },
});

for (const agentId of agents) {
  const loaded = loadConfig(process.env);
  markConfigApplied(process.env, agentId, runtimeConfigSignature(loaded.config, agentId));
}
await control.start();
writeStatus();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await control.close();
  process.exit(0);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
setInterval(() => {}, 60_000);
