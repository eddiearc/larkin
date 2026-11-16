import type http from "node:http";
import { assertWriteRequest, boundedJson } from "./dashboard-config-controller.js";
import { collectCapabilities, collectInstructionFiles, collectStandingPrompt, collectWorkspaceEntry, createInstructionFile, writeWorkspaceFile } from "./dashboard-view-model.js";

function statusCodeOf(error: unknown): number {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
}

function json(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Workspace browsing (GET), rule files (AGENTS.md / CLAUDE.md), the read-only capability list and standing prompt, and CSRF-protected text-file writes for the dashboard server. */
export function createDashboardWorkspaceController({ csrfCapability }: { csrfCapability: string }) {
  return {
    async handle(req: http.IncomingMessage, res: http.ServerResponse, requestUrl: URL): Promise<boolean> {
      if (requestUrl.pathname === "/api/workspace/file" && req.method === "PUT") {
        let body: Record<string, unknown>;
        try {
          assertWriteRequest(req, csrfCapability);
          // JSON escaping can roughly double a 1 MB text file.
          body = await boundedJson(req, 3 * 1024 * 1024);
        } catch {
          json(res, 403, { error: "workspace write rejected" });
          return true;
        }
        try {
          const saved = writeWorkspaceFile(body);
          console.log(`[dashboard] workspace write agent=${String(body.agentId)} path=${String(body.path)} bytes=${Buffer.byteLength(String(body.content))}`);
          json(res, 200, saved);
        } catch (error) {
          json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) });
        }
        return true;
      }
      if (requestUrl.pathname === "/api/agent-rules/file" && req.method === "POST") {
        let body: Record<string, unknown>;
        try {
          assertWriteRequest(req, csrfCapability);
          body = await boundedJson(req, 3 * 1024 * 1024);
        } catch {
          json(res, 403, { error: "rule file create rejected" });
          return true;
        }
        try {
          const created = createInstructionFile(body);
          console.log(`[dashboard] rule file create agent=${String(body.agentId)} name=${String(body.name)} bytes=${Buffer.byteLength(String(body.content))}`);
          json(res, 200, created);
        } catch (error) {
          json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) });
        }
        return true;
      }
      if (requestUrl.pathname === "/api/agent-capabilities") {
        try { json(res, 200, collectCapabilities(requestUrl.searchParams.get("agent"))); }
        catch (error) { json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) }); }
        return true;
      }
      if (requestUrl.pathname === "/api/agent-standing-prompt") {
        try { json(res, 200, collectStandingPrompt(requestUrl.searchParams.get("agent"))); }
        catch (error) { json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) }); }
        return true;
      }
      if (requestUrl.pathname === "/api/agent-rules") {
        try { json(res, 200, collectInstructionFiles(requestUrl.searchParams.get("agent"))); }
        catch (error) { json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) }); }
        return true;
      }
      if (requestUrl.pathname === "/api/workspace") {
        try { json(res, 200, collectWorkspaceEntry(requestUrl.searchParams.get("agent"), requestUrl.searchParams.get("path") || "")); }
        catch (error) { json(res, statusCodeOf(error), { error: error instanceof Error ? error.message : String(error) }); }
        return true;
      }
      return false;
    },
  };
}
