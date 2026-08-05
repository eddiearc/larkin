import * as larkinConfig from "../platform/config.js";
import {
  beginBuiltinPiCredentialTransaction,
  createOfficialPiCredentialRuntime,
  createOfficialPiLogoutRuntime,
  logoutOfficialPiProvider,
  officialPiAuthStatus,
} from "../runtime/pi-official-auth.js";

const APP_ID = /^cli_[A-Za-z0-9]+$/;

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const action = args[0] || "status";
  const json = args.includes("--json");
  const requestedAgent = flag(args, "--agent");
  let index = action === "logout" ? 2 : 1;
  let valid = action === "status" || action === "logout";
  while (valid && index < args.length) {
    const argument = args[index];
    if (argument === "--json" && action === "status") { index += 1; continue; }
    if (argument === "--agent" && args[index + 1]) { index += 2; continue; }
    valid = false;
  }
  if (!valid) {
    throw new Error("Usage: larkin pi-auth status [--agent <App ID>] [--json] | larkin pi-auth logout <provider> [--agent <App ID>]");
  }
  const loaded = larkinConfig.loadConfig(env);
  const agentId = requestedAgent || loaded.config.activeAgent || undefined;
  if (!agentId || !APP_ID.test(agentId)) throw new Error("请用 --agent <App ID> 选择 Agent");
  const agent = loaded.config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 不存在`);
  if (agent.runtime !== "pi" || agent.piDistribution !== "builtin") throw new Error(`Agent ${agentId} 不是内置 Pi`);
  if (action === "status") {
    const runtime = await createOfficialPiCredentialRuntime(loaded.configDir, agentId);
    const statuses = await officialPiAuthStatus(runtime);
    if (json) console.log(JSON.stringify({ agentId, credentials: statuses }));
    else if (statuses.length === 0) console.log(`Agent ${agentId} 尚无已配置的官方 Pi credential`);
    else {
      console.log(`Agent ${agentId} 官方 Pi credential：`);
      for (const entry of statuses) console.log(`  ${entry.providerName} (${entry.providerId}): ${entry.credentialType}/${entry.source}${entry.stored ? " [stored]" : " [ambient]"}`);
    }
    return;
  }
  const providerId = args[1];
  if (!providerId || providerId.startsWith("--") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
    throw new Error("logout 需要安全的 provider ID");
  }
  const transaction = beginBuiltinPiCredentialTransaction(loaded.configDir, agentId);
  try {
    const runtime = await createOfficialPiLogoutRuntime(loaded.configDir, agentId);
    await logoutOfficialPiProvider(runtime, providerId);
    transaction.commit();
  } catch (error) { transaction.rollback(); throw error; }
  console.log(`Agent ${agentId} 已退出 ${providerId}；其他 provider 未修改`);
}
