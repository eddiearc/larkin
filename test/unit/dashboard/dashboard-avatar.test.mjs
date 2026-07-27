import assert from "node:assert/strict";
import http from "node:http";
import { test } from "bun:test";
import {
  createDashboardAvatarCache,
  createDashboardAvatarController,
  isAllowedDashboardAvatarUrl,
} from "../../../dist/dashboard/dashboard-avatar.mjs";

const AVATAR = "https://s1-imfile.feishucdn.com/static-resource/v1/avatar.png";

test("dashboard avatar source accepts only the bounded Feishu CDN shape", () => {
  assert.equal(isAllowedDashboardAvatarUrl(AVATAR), true);
  for (const value of [
    "http://s1-imfile.feishucdn.com/static-resource/v1/avatar.png",
    "https://user:pass@s1-imfile.feishucdn.com/static-resource/v1/avatar.png",
    "https://s1-imfile.feishucdn.com:8443/static-resource/v1/avatar.png",
    "https://s1-imfile.feishucdn.com/other/avatar.png",
    "https://s1-imfile.feishucdn.com.evil.invalid/static-resource/v1/avatar.png",
    "https://127.0.0.1/static-resource/v1/avatar.png",
  ]) assert.equal(isAllowedDashboardAvatarUrl(value), false, value);
});

test("dashboard avatar cache validates image responses, bounds bytes, and reuses the same source", async () => {
  let calls = 0;
  let now = 1_000;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": "4" },
    });
  };
  const cache = createDashboardAvatarCache({ fetchImpl, now: () => now, ttlMs: 5_000 });
  const first = await cache.get("cli_AgentA1", AVATAR);
  const second = await cache.get("cli_AgentA1", AVATAR);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.contentType, "image/png");
  assert.deepEqual([...first.body], [137, 80, 78, 71]);
  assert.match(first.etag, /^"sha256-[a-f0-9]{64}"$/);

  now += 5_001;
  await cache.get("cli_AgentA1", AVATAR);
  assert.equal(calls, 2);

  const wrongType = createDashboardAvatarCache({
    fetchImpl: async () => new Response("not an image", { headers: { "Content-Type": "text/html" } }),
  });
  await assert.rejects(wrongType.get("cli_AgentA1", AVATAR), /unsupported avatar content type/);

  const tooLarge = createDashboardAvatarCache({
    fetchImpl: async () => new Response(new Uint8Array(2_000_001), {
      headers: { "Content-Type": "image/png", "Content-Length": "2000001" },
    }),
  });
  await assert.rejects(tooLarge.get("cli_AgentA1", AVATAR), /avatar exceeds 2000000 bytes/);
});

test("dashboard avatar default cache expires instead of pinning an upstream image indefinitely", async () => {
  let calls = 0;
  let now = 1_000;
  const cache = createDashboardAvatarCache({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return new Response(new Uint8Array([calls]), {
        headers: { "Content-Type": "image/png", "Content-Length": "1" },
      });
    },
  });
  assert.deepEqual([...((await cache.get("cli_AgentA1", AVATAR)).body)], [1]);
  now += 5 * 60 * 1_000 + 1;
  assert.deepEqual([...((await cache.get("cli_AgentA1", AVATAR)).body)], [2]);
});

test("dashboard avatar controller serves only a same-origin image route with cache validators", async () => {
  let upstreamCalls = 0;
  const controller = createDashboardAvatarController({
    resolveSource: (agentId) => agentId === "cli_AgentA1" ? AVATAR : null,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png", "Content-Length": "3" },
      });
    },
  });
  const server = http.createServer(async (req, res) => {
    const handled = await controller.handle(req, res, new URL(req.url || "/", "http://localhost"));
    if (!handled) { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const image = await fetch(`${base}/api/avatar/cli_AgentA1`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "private, max-age=60, must-revalidate");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("content-security-policy"), /default-src 'none'/);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3]);
    const etag = image.headers.get("etag");
    assert.match(etag, /^"sha256-[a-f0-9]{64}"$/);

    const cached = await fetch(`${base}/api/avatar/cli_AgentA1`, { headers: { "If-None-Match": etag } });
    assert.equal(cached.status, 304);
    assert.equal(upstreamCalls, 1);
    assert.equal((await fetch(`${base}/api/avatar/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/api/avatar/cli_AgentA1`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/api/other`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
