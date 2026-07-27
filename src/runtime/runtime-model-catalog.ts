export interface RuntimeModelDefinition {
  id: string;
  label?: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  verified?: string;
}

export type RuntimeModels = Record<string, RuntimeModelDefinition[]>;

// Larkin supports exactly these three native Runtime adapters. Pi, Codex and Claude replace
// these placeholders/fallbacks at runtime with their machine-readable catalogs.
// Claude's supported stdin control-channel list is the live authority; its entries below
// remain explicit compatibility candidates for config loading and discovery failures.
export const CURRENT_RUNTIME_MODELS: RuntimeModels = {
  codex: [
    { id: "default", label: "default", verified: "dynamic" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol · 静态兼容目录", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "low", verified: "authored-compatibility" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra · 静态兼容目录", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium", verified: "authored-compatibility" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna · 静态兼容目录", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium", verified: "authored-compatibility" },
    { id: "gpt-5.5", label: "GPT-5.5 · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.4", label: "GPT-5.4 · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.2", label: "GPT-5.2 · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5-codex", label: "GPT-5 Codex · 静态兼容目录", verified: "authored-compatibility" },
    { id: "gpt-5", label: "GPT-5 · 静态兼容目录", verified: "authored-compatibility" },
  ],
  claude: [
    { id: "default", label: "default", verified: "dynamic" },
    { id: "opus", label: "Claude Opus · 静态候选", verified: "authored-candidate" },
    { id: "opus[1m]", label: "Claude Opus 1M · 静态候选", verified: "authored-candidate" },
    { id: "fable", label: "Claude Fable · 静态候选", verified: "authored-candidate" },
    { id: "sonnet", label: "Claude Sonnet · 静态候选", verified: "authored-candidate" },
    { id: "haiku", label: "Claude Haiku · 静态候选", verified: "authored-candidate" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 · 静态候选", verified: "authored-candidate" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7 · 静态候选", verified: "authored-candidate" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6 · 静态候选", verified: "authored-candidate" },
    { id: "claude-fable-5", label: "Claude Fable 5 · 静态候选", verified: "authored-candidate" },
    { id: "claude-fable-5[1m]", label: "Claude Fable 5 1M · 静态候选", verified: "authored-candidate" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 · 静态候选", verified: "authored-candidate" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 · 静态候选", verified: "authored-candidate" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 · 静态候选", verified: "authored-candidate" },
  ],
  pi: [{ id: "default", label: "default", verified: "dynamic" }],
};
