import * as larkinConfig from "../platform/config.js";
import { hydrateRuntimeAgent } from "./runtime-agent-config.js";

interface ExecRequest { protocolVersion?: unknown; provider?: unknown; ids?: unknown }

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.LARKIN_INTERNAL_DISPATCH !== "1" || env.LARKIN_SECRET_PROVIDER_CONTEXT !== "bind") {
    throw new Error("lark-channel secret provider 只允许 Runtime/setup 内部 bind 调用");
  }
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 16 * 1024) throw new Error("secret provider request too large");
  }
  const request = JSON.parse(input) as ExecRequest;
  const { configDir, config } = larkinConfig.loadConfig(env);
  const agent = larkinConfig.selectAgent(config, env);
  if (request.protocolVersion !== 1 || request.provider !== "larkin-bot-credential"
      || !Array.isArray(request.ids) || request.ids.length !== 1 || request.ids[0] !== agent.feishuAppId) {
    throw new Error("secret provider request does not match the bound Agent");
  }
  const hydrated = hydrateRuntimeAgent(configDir, agent);
  process.stdout.write(`${JSON.stringify({ protocolVersion: 1, values: { [agent.feishuAppId]: hydrated.feishuAppSecret } })}\n`);
}
