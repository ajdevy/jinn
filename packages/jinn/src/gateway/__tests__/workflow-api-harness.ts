import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { vi } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { handleApiRequest } from "../api.js";

/** The request/response pair every Workflow HTTP route test drives the real
 *  handler with: a readable body with the headers the gateway reads, and a
 *  response that records the status and parses the JSON envelope back. */

export interface RequestOptions {
  /** Omit the bearer token, to exercise the 401 lane. */
  authorized?: boolean;
  contentType?: string;
  headers?: Record<string, string>;
}

export function request(method: string, url: string, body?: unknown, options: RequestOptions = {}) {
  const { authorized = true, contentType = "application/json", headers = {} } = options;
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: { host: "localhost", ...(authorized ? { authorization: "Bearer test-token" } : {}),
      "content-type": contentType, ...headers },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

export function rawRequest(method: string, url: string, raw: string) {
  const req = Readable.from([Buffer.from(raw)]);
  Object.assign(req, { method, url, headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" } });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

export function response() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; return this; },
    write(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    : undefined }) };
}

export function workflowToolHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

