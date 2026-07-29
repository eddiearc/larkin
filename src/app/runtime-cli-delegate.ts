import { runLarkCli } from "./lark-cli.js";
import { RUNTIME_CLI_BOUND_ENV, validateRuntimeCliDelegate } from "./runtime-cli-binding.js";

export function runRuntimeCliDelegate(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  try {
    const descriptor = validateRuntimeCliDelegate(env);
    return runLarkCli(argv, { ...env, [RUNTIME_CLI_BOUND_ENV]: descriptor.bindingId }, {
      nativeCommand: { command: descriptor.context.nativeCli, argsPrefix: [] },
    });
  } catch (error) {
    process.stderr.write(`larkin runtime CLI delegate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
