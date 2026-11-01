# Changelog

## 0.5.23

The standing prompt (`larkin-standing-v35`, card mode `larkin-standing-v42-card`) now requires a reply's `message_id` to be copied verbatim from the message being answered. A reply or other guarded write whose `--message-id` is not in this Agent's Inbox records now fails with a plain statement of that fact. Reminder envelopes drop the chat-send fallback for an unresolvable anchor and the legacy-anchor notes, and say once that people named in a reminder title are its content, not its recipients.

Reply mode can now be set per Agent: `agents.<id>.replyMode` (`card` or `cli`) overrides the global `replyMode`, and an Agent without it keeps following the global value, so existing configs behave the same. A global change no longer re-applies Agents that have their own mode. The dashboard sets the group message policy and the reply mode on each Agent's reply tab, and the global settings button and sheet are removed. Saving either value on that tab stores it on the Agent.

The Host no longer replies "我还在处理中，完成后会汇总更新。" as the bot when a turn runs past two minutes without an outbound message. Long turns keep only the OnIt reaction; any progress update comes from the Agent. The `last_outbound_at` / `last_outbound_by_target` fields that only suppressed that reply are no longer written; leftover values in existing state are ignored.

Changing a Codex Agent's model, reasoning effort, or Fast mode no longer restarts the Runtime or reconnects Feishu. The new settings apply from the next turn of the same thread, including while a turn is running. Clearing a setting back to the Codex default, or any other config change, still replaces the session. When a replacement does start a new Codex process, it now waits for the old process to release the thread before resuming instead of failing with an active-writer error, and startup errors emitted before the Host subscribes are delivered instead of dropped, so the Agent no longer silently stops accepting messages.

## 0.5.22

The processing-eye OnIt reaction now marks only messages explicitly addressed to the bot: private chats (DM / p2p) and group messages that @ the bot. Replies inside a topic the bot started no longer get the reaction without an @, so OnIt appears exactly where a streaming card can open. Larkin no longer records bot topic roots; a leftover `bot_topic_roots` key in existing state is ignored.

Streaming-card tool steps show each tool call's raw input instead of a tool label such as 执行命令, in private chats and groups alike: commands and search queries as written, structured arguments as JSON, file changes as paths; a call without input still shows its tool name. Inputs are not redacted. Each input is flattened to one line, and one longer than 200 characters keeps its head and tail with `…` in the middle. Steps no longer carry a status word; only a failed call is marked `· failed`. The card is now English throughout: Thinking…, Replying…, Running …, Replay · N tool calls · Ns, and the failure and nothing-to-reply notices, which also reach the plain-text fallback.

## 0.5.19

The Feishu processing-eye OnIt reaction is no longer a config switch. After a successful deliver, Larkin reacts OnIt only for private chats (DM / p2p), when the inbound event already marked the bot as mentioned, or when the user is talking inside a topic the bot started (a Feishu topic whose root is a bot-owned message). Ordinary group messages without @ and outside a bot-started topic never get the reaction, including free-mention chats that still wake the Agent.

The 0.5.18 `processingEye.enabled` key, `larkin config processing-eye`, and Dashboard 处理中表情 toggle are removed. Leftover keys in existing configs are ignored on load and dropped on the next config write. There is no on/off flag and no migration prompt.

## 0.5.18

The Feishu processing-eye OnIt reaction is now off by default. New installs and existing configs that omit `processingEye` no longer auto-react on inbound messages after upgrade; there is no migration prompt. Opt back in with `larkin config processing-eye global on`, a per-Agent `on`/`off`/`inherit` override, or the Dashboard 处理中表情 toggle. Explicit `enabled: false` and a missing key both skip the reactions API.

## 0.5.8

Lark setup now reconciles requested tenant permissions with actual grants and links missing scopes to the same application in the developer console. Required permissions still block setup until granted; optional permissions and event/callback verification are reported separately. Existing-application authorization preserves and checks its App ID before recording any capability state.

## 0.5.5

Pi uses a small Larkin-owned tmux Bash extension when tmux is available on macOS/Linux. Commands preserve their working directory, including non-Git paths with spaces; a foreground wait can return while the same command continues. The returned task ID supports inspection and cancellation, and background completion resumes the Agent. Native Windows and environments without tmux retain Pi's native Bash.

Removed the injected subagent plugin, its ledger/watchdog and supervised-command infrastructure, the 60-second Bash hard-kill rule, and mandatory delegation guidance. Pi-owned turns now occupy Runtime busy state without a second host prompt. Historical subagent files are left untouched. Background commands survive Pi shutdown in tmux; notification recovery across Pi restarts is not provided. No third-party tmux plugin is installed or redistributed.

## 0.5.4

Inbox Audit is now optional and off by default. The Dashboard and CLI support global and per-Agent switches and inspection gaps. Saving a gap updates scheduling without replacing Runtime sessions; editing a gap alone does not enable auditing. Only originally wake-eligible human group/topic work is audited.

Audit reads no longer mark work complete. Agents explicitly confirm a receipt after checking; receipts are scoped to an observation generation, and durable canonical sequence ordering protects newer work from stale completion or deferred registration. Contended registrations are retried durably. Unproven legacy audit-index rows are ignored while ordinary Inbox and conversation history remain intact.

## 0.5.3

External Pi initialization now runs with bounded concurrency and recovers from isolated startup-probe timeouts through the existing retry policy. Shutdown waits for pending initialization and closes late sessions. Generic Runtime and delivery failures show unavailable instead of incompatible, while explicit prerequisite failures and useful provider diagnostics are preserved. Recovery workflow tests wait for delivery consumption and Inbox watermarks to converge and isolate temporary state.

## 0.5.2

External pi now runs with the user's own Pi home; compaction settings move to the Agent workspace's `.pi/settings.json`; 0.5.0/0.5.1 started external pi with an empty agent dir and saw no logins. Stock pi 0.84.x does not emit `get_state.compactionCapabilities` (that handshake only existed for the bundled build); Larkin accepts the absence and keeps native compaction via the workspace settings file, while a present handshake must still match exactly.

## 0.5.1

External pi is accepted at 0.84.2 or newer instead of exactly 0.84.2; 0.5.0 refused newer pi and left every migrated Agent not ready.

## 0.5.0

BREAKING — builtin Pi is removed. Larkin supports only externally installed `pi`, `codex`, and `claude`. If the selected runtime is not installed, setup, runtime switch, and readiness fail with an explicit missing-install message.

Existing builtin-pi Agents migrate to external `pi` on first config load and keep their stored model. Larkin-owned Pi credential directories (`providers/pi/<agentId>/`) are deleted during that migration. Users must install and log in to `pi`, `codex`, or `claude` themselves.

The `pi-auth` and `pi-distribution` commands are removed. Invoking them returns the standard unknown-command error. Dashboard Provider Credentials and `/api/pi-auth/*` are gone.

`larkin setup --model <id>` again stores a catalog-validated model for the chosen runtime.
