import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_AVATAR_BYTES = 2_000_000;
const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const ALLOWED_CONTENT_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

export interface DashboardAvatarPayload {
  body: Buffer;
  contentType: string;
  etag: string;
}

type FetchAvatar = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function isAllowedDashboardAvatarUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && (url.port === "" || url.port === "443")
      && /^s\d+-imfile\.feishucdn\.com$/i.test(url.hostname)
      && url.pathname.startsWith("/static-resource/v1/");
  } catch {
    return false;
  }
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
    throw new Error(`avatar exceeds ${MAX_AVATAR_BYTES} bytes`);
  }
  if (!response.body) throw new Error("avatar response has no body");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_AVATAR_BYTES) {
      await reader.cancel();
      throw new Error(`avatar exceeds ${MAX_AVATAR_BYTES} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchDashboardAvatar(sourceUrl: string, fetchImpl: FetchAvatar): Promise<DashboardAvatarPayload> {
  if (!isAllowedDashboardAvatarUrl(sourceUrl)) throw new Error("avatar source is not allowed");
  const response = await fetchImpl(sourceUrl, {
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`avatar upstream returned ${response.status}`);
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("unsupported avatar content type");
  const body = await readBoundedBody(response);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  return { body, contentType, etag: `"sha256-${digest}"` };
}

export function createDashboardAvatarCache(options: {
  fetchImpl?: FetchAvatar;
  now?: () => number;
  ttlMs?: number;
} = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const entries = new Map<string, { sourceUrl: string; expiresAt: number; payload: DashboardAvatarPayload }>();
  return {
    async get(agentId: string, sourceUrl: string): Promise<DashboardAvatarPayload> {
      const cached = entries.get(agentId);
      if (cached && cached.sourceUrl === sourceUrl && cached.expiresAt > now()) return cached.payload;
      const payload = await fetchDashboardAvatar(sourceUrl, fetchImpl);
      entries.set(agentId, { sourceUrl, expiresAt: now() + ttlMs, payload });
      return payload;
    },
  };
}

export function createDashboardAvatarController(options: {
  resolveSource: (agentId: string) => string | null;
  fetchImpl?: FetchAvatar;
}) {
  const cache = createDashboardAvatarCache({ fetchImpl: options.fetchImpl });
  return {
    async handle(req: IncomingMessage, res: ServerResponse, requestUrl: URL): Promise<boolean> {
      const match = /^\/api\/avatar\/([^/]+)$/.exec(requestUrl.pathname);
      if (!match) return false;
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }); res.end(); return true;
      }
      let agentId: string;
      try { agentId = decodeURIComponent(match[1]); }
      catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end("bad request"); return true; }
      try {
        const sourceUrl = options.resolveSource(agentId);
        if (!sourceUrl) { res.writeHead(404, { "Cache-Control": "no-store" }); res.end("not found"); return true; }
        const payload = await cache.get(agentId, sourceUrl);
        if (req.headers["if-none-match"] === payload.etag) { res.writeHead(304, { ETag: payload.etag }); res.end(); return true; }
        res.writeHead(200, {
          "Content-Type": payload.contentType,
          "Content-Length": payload.body.byteLength,
          "Cache-Control": "private, max-age=60, must-revalidate",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          ETag: payload.etag,
        });
        res.end(req.method === "HEAD" ? undefined : payload.body);
      } catch {
        res.writeHead(502, { "Cache-Control": "no-store" }); res.end("avatar unavailable");
      }
      return true;
    },
  };
}
