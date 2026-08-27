import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  cancelSupervisedCommand,
  LARKIN_SUPERVISED_COMMAND_CAPABILITY,
  reapSupervisedCommands,
  resolveSupervisedCwd,
  startSupervisedCommand,
  supervisedWaitSeconds,
  waitSupervisedCommand,
} from "./pi-supervised-command.js";
void LARKIN_SUPERVISED_COMMAND_CAPABILITY;

function ownerOf(ctx: { sessionManager?: object } | undefined): object {
  const owner = ctx?.sessionManager;
  if (!owner) throw new Error("supervised commands require a session");
  return owner;
}

export default function (pi: ExtensionAPI): void {
  const waitCap = supervisedWaitSeconds();
  pi.on("session_shutdown", async (_event, ctx) => {
    const owner = (ctx as { sessionManager?: object } | undefined)?.sessionManager;
    if (owner) await reapSupervisedCommands(owner);
  });

  pi.registerTool({
    name: "supervised_start",
    label: "supervised_start",
    description: "Start one supervised process with executable+args (shell:false). Background-agent only. Returns a handle; use supervised_wait in <=60s slices. Do not use bash for work that must outlive 60s.",
    parameters: Type.Object({
      executable: Type.String({ description: "Executable path or name. No shell." }),
      args: Type.Array(Type.String(), { description: "Argument vector. No shell metacharacters are interpreted." }),
      cwd: Type.Optional(Type.String({ description: "Optional cwd inside the child session root. Symlinks and path escape are rejected." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = ctx as { sessionManager?: object; cwd?: string };
      const root = typeof session.cwd === "string" && session.cwd.length > 0 ? session.cwd : process.cwd();
      const started = startSupervisedCommand({
        owner: ownerOf(session),
        executable: params.executable,
        args: params.args ?? [],
        cwd: resolveSupervisedCwd(root, params.cwd),
      });
      return { content: [{ type: "text", text: JSON.stringify(started) }], details: started };
    },
  });

  pi.registerTool({
    name: "supervised_wait",
    label: "supervised_wait",
    description: `Wait on a supervised handle for at most ${waitCap}s. Timeout returns status=running without killing the process. Then the turn can accept Steer before the next wait.`,
    parameters: Type.Object({
      handle: Type.String({ description: "Handle from supervised_start" }),
      timeout: Type.Optional(Type.Number({ description: `Wait seconds, max ${waitCap}`, maximum: waitCap, minimum: 1 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await waitSupervisedCommand(ownerOf(ctx as { sessionManager?: object }), params.handle, params.timeout);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "supervised_cancel",
    label: "supervised_cancel",
    description: "Cancel a supervised handle and reap its process tree.",
    parameters: Type.Object({
      handle: Type.String({ description: "Handle from supervised_start" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = await cancelSupervisedCommand(ownerOf(ctx as { sessionManager?: object }), params.handle);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
