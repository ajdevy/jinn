import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-http-"));
process.env.JINN_HOME = tmp;

type Mod = typeof import("../mcp-http.js");
let mod: Mod;

beforeAll(async () => {
  mod = await import("../mcp-http.js");
});

function req(body: unknown, headers: Record<string, string> = {}): import("node:http").IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as import("node:http").IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = {
    "content-type": "application/json",
    ...headers,
  };
  return r;
}

function res() {
  const out: { status?: number; body?: string } = {};
  const handle = {
    writeHead(status: number) { out.status = status; return handle; },
    end(body?: string) { out.body = body; return handle; },
  } as unknown as import("node:http").ServerResponse;
  return { res: handle, out };
}

function ctx(token: string | undefined = "secret-token") {
  return {
    gatewayAuthToken: token,
    jinnHome: tmp,
    runtimePort: 7777,
    getConfig: () => ({ gateway: { port: 7777 } }),
  } as unknown as import("../api.js").ApiContext;
}

/** Passing undefined to ctx() would take the default parameter, not clear it. */
function ctxWithoutToken() {
  return { gatewayAuthToken: undefined, jinnHome: tmp, runtimePort: 7777, getConfig: () => ({ gateway: { port: 7777 } }) } as unknown as import("../api.js").ApiContext;
}

const AUTH = { authorization: "Bearer secret-token" };

beforeEach(() => {
  mod.resetMcpHttpTools();
  vi.restoreAllMocks();
});

describe("POST /api/mcp", () => {
  it("ignores any other path", async () => {
    const { res: r, out } = res();
    const handled = await mod.handleMcpHttp(req({}), r, { method: "POST", pathname: "/api/sessions" }, ctx());
    expect(handled).toBe(false);
    expect(out.status).toBeUndefined();
  });

  it("refuses a request with no credential", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(req({ jsonrpc: "2.0", id: 1, method: "ping" }), r, { method: "POST", pathname: "/api/mcp" }, ctx());
    expect(out.status).toBe(401);
  });

  it("refuses a wrong credential", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(
      req({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer wrong" }),
      r, { method: "POST", pathname: "/api/mcp" }, ctx(),
    );
    expect(out.status).toBe(401);
  });

  it("refuses to serve at all when the gateway has no token", async () => {
    // Otherwise an unauthenticated gateway would hand the whole tool surface to
    // anyone who can reach the port.
    const { res: r, out } = res();
    await mod.handleMcpHttp(req({ jsonrpc: "2.0", id: 1, method: "ping" }, AUTH), r, { method: "POST", pathname: "/api/mcp" }, ctxWithoutToken());
    expect(out.status).toBe(503);
  });

  it("rejects a non-POST", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(req({}, AUTH), r, { method: "GET", pathname: "/api/mcp" }, ctx());
    expect(out.status).toBe(405);
  });

  it("answers initialize with a protocol version and server info", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(
      req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, AUTH),
      r, { method: "POST", pathname: "/api/mcp" }, ctx(),
    );
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body!);
    expect(body.result.serverInfo.name).toBe("jinn");
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("lists the same tools the stdio server exposes", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(
      req({ jsonrpc: "2.0", id: 2, method: "tools/list" }, AUTH),
      r, { method: "POST", pathname: "/api/mcp" }, ctx(),
    );
    const body = JSON.parse(out.body!);
    const { buildTools } = await import("../../mcp/server.js");
    expect(body.result.tools.length).toBe(buildTools({ notesEnabled: false }).length);
    expect(body.result.tools.every((t: { name: string }) => typeof t.name === "string")).toBe(true);
  });

  it("answers 202 with no body for a notification", async () => {
    // A JSON-RPC notification carries no id and must never get a response.
    const { res: r, out } = res();
    await mod.handleMcpHttp(
      req({ jsonrpc: "2.0", method: "notifications/initialized" }, AUTH),
      r, { method: "POST", pathname: "/api/mcp" }, ctx(),
    );
    expect(out.status).toBe(202);
    expect(out.body).toBeUndefined();
  });

  it("answers a batch with an array and drops the notifications from it", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(
      req([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ], AUTH),
      r, { method: "POST", pathname: "/api/mcp" }, ctx(),
    );
    const body = JSON.parse(out.body!);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((m: { id: number }) => m.id)).toEqual([1, 2]);
  });

  it("rejects a malformed message rather than passing it to the dispatcher", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(req(["not-an-object"], AUTH), r, { method: "POST", pathname: "/api/mcp" }, ctx());
    expect(out.status).toBe(400);
  });

  it("rejects an empty batch", async () => {
    const { res: r, out } = res();
    await mod.handleMcpHttp(req([], AUTH), r, { method: "POST", pathname: "/api/mcp" }, ctx());
    expect(out.status).toBe(400);
  });
});
