import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CLICKABLE_LINK_V20_GUIDANCE = [
  "When a URL must be visible, clickable, or openable by the recipient, include the complete bare `https://...` URL as visible text. Do not rely solely on `[label](URL)`, because Feishu client rendering is unreliable. A label may also be included, but the bare URL must remain present.",
  "Never rewrite or normalize an exact or verbatim user-supplied body to expose a URL; the existing exact-content paths remain authoritative and preserve the supplied body unchanged.",
];

export function v19Counterfactual(standingPrompt) {
  if (standingPrompt?.version !== "larkin-standing-v20" || typeof standingPrompt.content !== "string") {
    throw new Error("v19 counterfactual requires a v20 standing prompt");
  }
  let content = standingPrompt.content;
  for (const line of CLICKABLE_LINK_V20_GUIDANCE) {
    const count = content.split(line).length - 1;
    if (count !== 1 || !content.includes(`${line}\n`)) throw new Error("v20 guidance line must occur exactly once");
    content = content.replace(`${line}\n`, "");
  }
  if (CLICKABLE_LINK_V20_GUIDANCE.some((line) => content.includes(line))) throw new Error("v20 guidance survived counterfactual");
  return {
    version: "larkin-standing-v19",
    content,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

export function isolatedNativeEnv(baseEnv, { temp, binDir, codexCommand, traceFile }) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    env[key] = /^(?:LARK|FEISHU)/i.test(key) ? undefined : value;
  }
  const home = path.join(temp, "home");
  const nonexistentConfig = path.join(temp, "nonexistent-provider-config");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.rmSync(nonexistentConfig, { recursive: true, force: true });
  env.HOME = home;
  env.XDG_CONFIG_HOME = nonexistentConfig;
  const inheritedCodexHome = baseEnv.CODEX_HOME || (baseEnv.HOME ? path.join(baseEnv.HOME, ".codex") : "");
  if (inheritedCodexHome && fs.existsSync(inheritedCodexHome)) env.CODEX_HOME = inheritedCodexHome;
  env.PATH = [binDir, path.dirname(codexCommand), path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter);
  env.CLICKABLE_EVAL_TRACE_FILE = traceFile;
  for (const [key, value] of Object.entries(env)) {
    if (/^(?:LARK|FEISHU)/i.test(key) && value !== undefined) throw new Error(`unsafe inherited provider environment: ${key}`);
  }
  if (fs.existsSync(path.join(home, ".larkin")) || fs.existsSync(nonexistentConfig)) {
    throw new Error("provider config isolation failed");
  }
  return env;
}

export function gradeNativeCommandAudit(commandAudit, fakeLarkin, fakeLarkCli) {
  const failures = [];
  if (!Array.isArray(commandAudit) || commandAudit.length !== 1) {
    failures.push({ rule: "native_command_count", detail: `expected one command execution, observed ${commandAudit?.length ?? 0}` });
  }
  for (const event of Array.isArray(commandAudit) ? commandAudit : []) {
    if (event.item_type !== "commandExecution" || typeof event.command !== "string" || event.exit_code !== 0) {
      failures.push({ rule: "native_command_shape", detail: "command execution was malformed or unsuccessful" });
      continue;
    }
    if (!event.command.includes(fakeLarkin) || event.command.includes(fakeLarkCli)) {
      failures.push({ rule: "fake_sink_only", detail: "command did not exclusively select the controlled larkin sink" });
    }
  }
  return { passed: failures.length === 0, failures };
}
