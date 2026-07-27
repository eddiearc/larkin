/** Pure outer-shell helpers used by the Feishu Agent transport. */

export type TargetMap<T = string> = Record<string, T>;

/**
 * Resolve a larkin target through the canonical Agent-local Feishu map.
 * The base-target fallback intentionally preserves the transport's existing
 * split semantics; protocol parsing does not belong in this shell helper.
 */
export function resolveMappedChatId<T>(map: TargetMap<T>, target: unknown): T | "" {
  if (target && map[String(target)]) return map[String(target)];
  if (target) {
    const base = String(target).split(":").slice(0, 2).join(":");
    if (map[base]) return map[base];
  }
  return "";
}

/** Redact common credential shapes and bound locally persisted conversation text. */
export function safeConversationExcerpt(value: unknown, max = 360): string {
  let excerpt = String(value || "").replace(/\s+/g, " ").trim();
  excerpt = excerpt
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[已隐藏凭证]")
    .replace(/\b(token|secret|password|passwd)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]");
  return excerpt.length > max ? `${excerpt.slice(0, max - 1)}…` : excerpt;
}

/** Decide whether Feishu should receive rich Markdown instead of a plain text bubble. */
export function looksLikeMarkdown(value: unknown): boolean {
  const text = String(value);
  return /(^|\n)#{1,6}\s/.test(text)
    || /\*\*[^*\n]+\*\*/.test(text)
    || /(^|\n)\s*([-*+]|\d+\.)\s+\S/.test(text)
    || /```/.test(text)
    || /`[^`\n]+`/.test(text)
    || /(^|\n)>\s/.test(text)
    || /\[[^\]\n]+\]\(https?:[^)\s]+\)/.test(text)
    || /(^|\n)\|.+\|\s*\n\s*\|[\s:|-]+\|/.test(text);
}

export function isImageMime(value: unknown): boolean {
  return /^image\//.test(String(value || ""));
}
