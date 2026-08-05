export type StoredAgent = {
  runtime: string;
  model: string;
  piDistribution?: "external" | "builtin";
  effort?: string;
  noMentionChats?: string[];
  mentionPolicy?: "require" | "free";
  chatMentionPolicies?: Record<string, "require" | "free">;
  createdAt?: string;
};

export type StoredConfig = {
  version: 3 | 4;
  serverId: string;
  mentionPolicy?: "require" | "free";
  activeAgent: string | null;
  agents: Record<string, StoredAgent>;
};

export type BindingProfile = { name?: string; appId: string };

function cloneAgent(agent: StoredAgent): StoredAgent {
  const chatMentionPolicies = { ...(agent.chatMentionPolicies || {}) };
  for (const chatId of agent.noMentionChats || []) chatMentionPolicies[chatId] = "free";
  return {
    runtime: agent.runtime,
    model: agent.model,
    ...(agent.piDistribution ? { piDistribution: agent.piDistribution } : {}),
    ...(agent.effort ? { effort: agent.effort } : {}),
    ...(agent.mentionPolicy ? { mentionPolicy: agent.mentionPolicy } : {}),
    ...(Object.keys(chatMentionPolicies).length ? { chatMentionPolicies } : {}),
    ...(agent.createdAt ? { createdAt: agent.createdAt } : {}),
  };
}

export function planSingleRootBinding({
  config,
  profile,
  requestedAgent,
  runtime,
  piDistribution,
  model,
  defaultModel,
  supportedReasoningEfforts,
  now,
}: {
  config: StoredConfig;
  profile: BindingProfile;
  requestedAgent?: string;
  runtime?: string;
  piDistribution?: "external" | "builtin";
  model?: string;
  defaultModel: string;
  supportedReasoningEfforts: readonly string[];
  now: string;
}): StoredConfig {
  if (!/^cli_[A-Za-z0-9]+$/.test(profile.appId)) throw new Error(`profile.appId 不是合法飞书 App ID：${profile.appId}`);
  if (typeof defaultModel !== "string" || !defaultModel) throw new Error("defaultModel 必须由 runtime 模型目录显式提供");
  if (!Array.isArray(supportedReasoningEfforts) || supportedReasoningEfforts.some((effort) => typeof effort !== "string" || !effort)) {
    throw new Error("supportedReasoningEfforts 必须由目标模型目录显式提供为字符串数组");
  }
  if (requestedAgent && requestedAgent !== profile.appId) {
    throw new Error(`--agent 必须与 profile App ID 一致：${requestedAgent} != ${profile.appId}`);
  }
  const agents = Object.fromEntries(Object.entries(config.agents).map(([key, agent]) => [key, cloneAgent(agent)]));
  const prior = agents[profile.appId];
  const nextRuntime = runtime || prior?.runtime || "pi";
  const nextPiDistribution = nextRuntime === "pi"
    ? piDistribution || (prior?.runtime === "pi" ? prior.piDistribution : undefined)
    : undefined;
  if (prior) {
    const { effort, piDistribution: _priorPiDistribution, ...withoutEffort } = prior;
    agents[profile.appId] = {
      ...withoutEffort,
      runtime: nextRuntime,
      model: model || (prior.runtime === nextRuntime ? prior.model : defaultModel),
      ...(nextPiDistribution ? { piDistribution: nextPiDistribution } : {}),
      ...(effort && supportedReasoningEfforts.includes(effort) ? { effort } : {}),
    };
  } else {
    agents[profile.appId] = { runtime: nextRuntime, model: model || "default", ...(nextPiDistribution ? { piDistribution: nextPiDistribution } : {}), createdAt: now };
  }
  return {
    version: 4,
    serverId: config.serverId,
    mentionPolicy: config.mentionPolicy || "require",
    activeAgent: config.activeAgent || profile.appId,
    agents,
  };
}
