export type MentionPolicy = "require" | "free";

/** How a group message policy reads in the dashboard: what the Agent does with group messages that do not @ it. */
export const MENTION_POLICY_OPTIONS: Record<MentionPolicy, { title: string; detail: string }> = {
  require: { title: "只回 @ 它的", detail: "没 @ 它的消息它不看。适合人多、话题杂的群。" },
  free: { title: "每条都看", detail: "没 @ 它也会看，自己判断要不要接话。适合小群，花的额度更多。" },
};
