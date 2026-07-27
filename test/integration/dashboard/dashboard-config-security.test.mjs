import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = "cli_dashboardConfigA1";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("dashboard config API is sanitized, same-origin/CSRF protected, bounded, and allowlisted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-config-"));
  const port = await freePort();
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3, serverId: "server-secret-internal", activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "gpt-5.6-sol", noMentionChats: ["oc_legacy"] } },
  })}\n`, { mode: 0o600 });
  const stateDir = path.join(root, "state", "agents", APP);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "feishu-map.json"), JSON.stringify({
    "#产品讨论群": "oc_legacy",
    "#产品讨论群:thread123": "oc_legacy",
    "dm:@person": "oc_direct",
    "#c0ffee12345": "oc_unknown",
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(ROOT, "dist/app/dashboard.mjs"), "--port", String(port)], {
    cwd: ROOT, env: { ...process.env, LARKIN_CONFIG_DIR: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 5_000;
    while (!output.includes(`http://localhost:${port}`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(output, new RegExp(`http://localhost:${port}`));
    const base = `http://localhost:${port}`;
    const page = await fetch(`${base}/`).then((response) => response.text());
    const csrf = JSON.parse(page.match(/"csrfCapability":("[^"]+")/)?.[1] || "null");
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
    assert.match(page, /Larkin Agent workbench/);

    const privateHeaders = { "X-Larkin-CSRF": csrf };
    const view = await fetch(`${base}/api/config`, { headers: privateHeaders }).then((response) => response.json());
    assert.equal(view.version, 4);
    assert.equal(view.mentionPolicy, "require");
    assert.equal(view.agents[0].mention.chatMentionPolicies, undefined);
    assert.deepEqual(view.agents[0].knownChats, [
      { chatId: "oc_legacy", displayName: "产品讨论群", kind: "group", override: "free", effective: "free", source: "chat" },
    ], "Dashboard configuration lists explicit chatMentionPolicies only");
    assert.equal(JSON.stringify(view).includes("server-secret-internal"), false);
    assert.equal(JSON.stringify(view).includes(root), false);

    const before = fs.readFileSync(path.join(root, "config.json"), "utf8");
    const raw = JSON.stringify({ operation: "set-global-mention", value: "free" });
    const rejected = [
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: raw }),
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://evil.example", "X-Larkin-CSRF": csrf }, body: raw }),
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "text/plain", Origin: base, "X-Larkin-CSRF": csrf }, body: raw }),
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": "wrong" }, body: raw }),
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": csrf }, body: JSON.stringify({ operation: "write-raw", serverId: "replace" }) }),
      await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": csrf }, body: JSON.stringify({ operation: "set-global-mention", value: "free", padding: "x".repeat(17_000) }) }),
    ];
    assert.deepEqual(rejected.map((response) => response.status), [400, 400, 400, 400, 400, 400]);
    assert.equal(fs.readFileSync(path.join(root, "config.json"), "utf8"), before);

    const accepted = await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": csrf }, body: raw });
    assert.equal(accepted.status, 200);
    const result = await accepted.json();
    assert.deepEqual({ ok: result.ok, persisted: result.persisted, applyState: result.applyState }, { ok: true, persisted: true, applyState: "saved_not_applied" });
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(stored.version, 4);
    assert.equal(stored.mentionPolicy, "free");
    assert.deepEqual(stored.agents[APP].chatMentionPolicies, { oc_legacy: "free" });

    const inherit = await fetch(`${base}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": csrf }, body: JSON.stringify({ operation: "set-chat-mention", agentId: APP, chatId: "oc_legacy", value: "inherit" }) });
    assert.equal(inherit.status, 200);
    const afterInherit = await fetch(`${base}/api/config`, { headers: privateHeaders }).then((response) => response.json());
    assert.deepEqual(afterInherit.agents[0].knownChats, [], "inherit removes the group from the explicit Dashboard configuration list");

    const applyMissingOrigin = await fetch(`${base}/api/config/apply`, { method: "POST", headers: { "Content-Type": "application/json", "X-Larkin-CSRF": csrf }, body: JSON.stringify({ agentId: APP }) });
    const applyBadCsrf = await fetch(`${base}/api/config/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": "bad" }, body: JSON.stringify({ agentId: APP }) });
    const applyOffline = await fetch(`${base}/api/config/apply`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Larkin-CSRF": csrf }, body: JSON.stringify({ agentId: APP }) });
    assert.deepEqual([applyMissingOrigin.status, applyBadCsrf.status, applyOffline.status], [409, 409, 409]);
    const pendingView = await fetch(`${base}/api/config`, { headers: privateHeaders }).then((response) => response.json());
    assert.equal(pendingView.agents[0].apply.applyState, "pending");
  } finally {
    child.kill("SIGINT");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
