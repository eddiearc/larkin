/** Structural host API used by Larkin Pi extensions. Provided by the user's `pi` process. */
export interface PiExtensionAPI {
  on(event: string, handler: (...args: any[]) => unknown): void;
  registerTool(tool: Record<string, any>): void;
}

export type BashToolInput = {
  command: string;
  timeout?: number;
};
