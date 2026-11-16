// Who delivers the reply to a polled Feishu IM message.
// cli (default): the model sends the reply itself with `larkin im +messages-reply`.
// card: the Host streams the model's assistant text into a CardKit card. It needs the
// cardkit:card:write scope, which bots set up before card mode lack, so it is opt-in.
export type ReplyMode = "card" | "cli";

/** Process-level fallback used only when Larkin config has no global replyMode. */
export function replyModeFromEnv(env: NodeJS.ProcessEnv = process.env): ReplyMode {
  return env.LARKIN_REPLY_MODE === "card" ? "card" : "cli";
}
