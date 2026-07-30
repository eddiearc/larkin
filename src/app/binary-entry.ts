#!/usr/bin/env bun

import { INTERNAL_COMMAND_MARKER, INTERNAL_MODES, type InternalMode } from "./internal-command.js";

declare const LARKIN_WRAPPED_ENTRY: boolean | undefined;

function normalizeArgv(mode: string, rest: readonly string[]): void {
  process.env.LARKIN_INTERNAL_DISPATCH = "1";
  process.argv = [process.execPath, `${INTERNAL_COMMAND_MARKER} ${mode}`, ...rest];
}

async function dispatchInternal(mode: InternalMode, rest: string[]): Promise<void> {
  normalizeArgv(mode, rest);
  switch (mode) {
    case "run": await (await import("./run.js")).main(); return;
    case "setup": await (await import("./setup.js")).main(); return;
    case "runtime-process": await (await import("./runtime-process.js")).main(); return;
    case "agent-cli": await (await import("./agent-cli.js")).main(rest, process.env); return;
    case "lark-cli": process.exitCode = await (await import("./lark-cli.js")).runLarkCliProcess(rest, process.env); return;
    case "runtime-model-directory": await (await import("./runtime-model-directory.js")).main(); return;
    case "agent-config": await import("./agent-config.js"); return;
    case "session-cli": await (await import("./session-cli.js")).main(rest, process.env); return;
    case "lark": await import("./lark.js"); return;
    case "dashboard": await import("./dashboard.js"); return;
    case "bot-register": await (await import("../setup/bot-register.js")).main(); return;
    case "setup-bind": await (await import("../setup/setup-bind.js")).main(); return;
    case "grant-scopes": await (await import("../setup/grant-scopes.js")).main(); return;
    case "lark-channel-secret": await (await import("./lark-channel-secret.js")).main(process.env); return;
  }
}

export async function main(): Promise<void> {
  const standalone = process.env.LARKIN_STANDALONE === "1";
  if (!standalone && process.argv[1]) process.env.LARKIN_BINARY_ENTRY_PATH = process.argv[1];
  const argv = process.argv.slice(standalone ? 1 : 2);
  if (argv[0] === INTERNAL_COMMAND_MARKER) {
    const mode = argv[1] as InternalMode | undefined;
    if (!mode || !INTERNAL_MODES.includes(mode)) throw new Error("invalid internal command");
    await dispatchInternal(mode, argv.slice(2));
    return;
  }
  process.argv = [process.execPath, "larkin", ...argv];
  await import("./cli.js");
}

if (typeof LARKIN_WRAPPED_ENTRY === "undefined" || !LARKIN_WRAPPED_ENTRY) {
  main().catch((error) => {
    process.stderr.write(`larkin: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
