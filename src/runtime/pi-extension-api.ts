import { createRequire } from "node:module";

/** Structural host API used by Larkin Pi extensions. Provided by the user's `pi` process. */
export interface PiExtensionAPI {
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerTool(tool: Record<string, any>): void;
}

export type BashToolInput = {
  command: string;
  timeout?: number;
};

type BashToolDefinition = {
  name?: string;
  label?: string;
  description?: string;
  execute: (...args: any[]) => Promise<unknown>;
  [key: string]: unknown;
};

/** Load `createBashToolDefinition` from the host Pi that is running this extension. */
export function loadHostCreateBashToolDefinition(): (cwd: string) => BashToolDefinition {
  const require = createRequire(import.meta.url);
  const scope = "earendil-works";
  const name = "pi-coding-agent";
  const loaded = require(`@${scope}/${name}`) as { createBashToolDefinition?: (cwd: string) => BashToolDefinition };
  if (typeof loaded.createBashToolDefinition !== "function") {
    throw new Error("host Pi is missing createBashToolDefinition");
  }
  return loaded.createBashToolDefinition;
}
