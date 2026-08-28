import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { PiRpcClient } from "../../../dist/runtime/pi-rpc-client.mjs";
import { stageBuiltinPiProvider } from "../../../dist/runtime/pi-provider-config.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const ENABLED = process.env.LARKIN_RUN_SUPERVISED_STANDALONE_BINARY === "1";

function checked(result, label) {
  assert.equal(result.status, 0, `${label}\n${result.stdout || ""}\n${result.stderr || ""}`);
  return result;
}

function sse(payloads) {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
}

function toolCall(name, args) {
  return sse([
    { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] },
    { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
    { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

test.skipIf(!ENABLED)("compiled standalone binary public Agent start/wait/cancel", {
  timeout: 240_000,
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-sa-bin-"));
  const release = path.join(temp, "release");
  try {
    checked(spawnSync(process.execPath, ["run", "build"], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, env: process.env,
    }), "build dist");
    checked(spawnSync(process.execPath, [
      "scripts/release/build.ts",
      "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", release,
      "--allow-dirty",
    ], { cwd: ROOT, encoding: "utf8", timeout: 150_000, env: process.env }), "compile standalone-entry");
    const manifest = JSON.parse(fs.readFileSync(path.join(release, "release-manifest.json"), "utf8"));
    const artifact = path.join(release, manifest.artifacts[0].file);
    assert.equal(fs.existsSync(artifact), true, "standalone artifact missing");

    const rpcHome = fs.mkdtempSync(path.join(ROOT, ".tmp-sa-rpc-"));
    const agentId = "cli_saSupervisedA1";
    const served = [];
    const bodies = [];
    let parentAgent = false;
    const server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const body = raw.replaceAll("\\", "");
        bodies.push(body.slice(0, 2_000));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const child = /"name"\s*:\s*"supervised_start"/.test(body);
        const handle = body.match(/"handle"\s*:\s*"([0-9a-f]+)"/i)?.[1];
        if (!child && !parentAgent) {
          parentAgent = true;
          served.push("Agent");
          response.end(toolCall("Agent", {
            prompt: "run supervised command",
            description: "sa-bin",
            subagent_type: "general-purpose",
            run_in_background: true,
          }));
          return;
        }
        if (child && handle && /"status"\s*:\s*"running"/.test(body)) {
          served.push("supervised_cancel");
          response.end(toolCall("supervised_cancel", { handle }));
          return;
        }
        if (child && handle && served.includes("supervised_start")) {
          served.push("supervised_wait");
          response.end(toolCall("supervised_wait", { handle, timeout: 1 }));
          return;
        }
        if (child && !served.includes("supervised_start")) {
          served.push("supervised_start");
          response.end(toolCall("supervised_start", {
            executable: process.execPath,
            args: ["-e", "setTimeout(() => {}, 8000)"],
          }));
          return;
        }
        served.push("stop");
        response.end(sse([
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]));
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    const transaction = stageBuiltinPiProvider(rpcHome, agentId, {
      distribution: "builtin", preset: "custom", baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "fixture-key", model: "fixture-model",
    });
    transaction.commit();
    const child = spawn(artifact, ["__internal", "pi-rpc", "--mode", "rpc", "--no-session", "--model", "larkin-custom/fixture-model"], {
      cwd: rpcHome,
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: rpcHome,
        LARKIN_HOME: rpcHome,
        HOME: rpcHome,
        PI_CODING_AGENT_DIR: path.join(rpcHome, "providers", "pi", agentId),
        PI_TELEMETRY: "0",
        LARKIN_PI_SUPERVISED_WAIT_SECONDS: "1",
        LARKIN_PI_SUPERVISED_LIFE_SECONDS: "8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new PiRpcClient(child, { requestTimeoutMs: 30_000 });
    const tools = [];
    client.subscribe((event) => {
      if (event?.type === "tool_execution_start" || event?.type === "tool_execution_end") {
        tools.push(`${event.type}:${event.toolName || event.name || JSON.stringify(event)}`);
      }
    });
    try {
      await client.request("prompt", { message: "Spawn a background agent that starts, waits, and cancels a supervised process." });
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (served.includes("supervised_start") && served.includes("supervised_wait") && served.includes("supervised_cancel")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(tools.join("\n"), /Agent/);
      assert.ok(served.includes("supervised_start"), `missing start: ${served.join(",")} bodies=${bodies.length}`);
      assert.ok(served.includes("supervised_wait"), `missing wait: ${served.join(",")}`);
      assert.ok(served.includes("supervised_cancel"), `missing cancel: ${served.join(",")}`);
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(rpcHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
