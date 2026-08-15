import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

/**
 * Who owns the response bytes for the domain routers.
 *
 * route-helpers.ts states the rule in prose — "a module that rolls its own
 * `send` drops the gzip/br negotiation" — but nothing enforced it, and
 * six modules (workflow-api, heartbeat-api, talk-api, talk-turn-api,
 * talk-tts-api, files) each grew a private `send`/`json` writing `Content-Type`
 * and nothing else. That is invisible from every existing test: the JSON is
 * right, the status is right, and the only thing wrong is that a 40 KB workflow
 * run list crosses the wire uncompressed. So this file asserts on the wire.
 *
 * Everything is driven through `handleApiRequest`, never by importing a domain
 * module: `__acceptEncoding` is stashed by the dispatcher, so a test calling a
 * module directly would be asserting on its own rig. domain-router-harness.ts's
 * response mock discards headers, hence the local one below.
 *
 * Group B pins the other half of the same seam — routing a module's errors
 * through shared helpers must not swallow the cause, so workflow-api's
 * unexpected-error branch has to log what it discards behind its fixed 500.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../../shared/logger.js";
import { handleApiRequest, type ApiContext } from "../api.js";
import { MIN_COMPRESS_BYTES } from "../compress.js";
import { FILES_DIR } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";
import type { WorkflowService } from "../../workflows/service.js";

/** Keeps what the shared harness throws away: the header block handed to
 *  `writeHead`, and the raw bytes. `Content-Encoding` is a claim about those
 *  bytes, and only the bytes can confirm it. */
function captureRes() {
  let status = 0;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  const push = (chunk?: Buffer | string) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  const res = {
    writeHead(next: number, block?: Record<string, string>) {
      status = next;
      for (const [key, value] of Object.entries(block ?? {})) headers[key.toLowerCase()] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    write(chunk: Buffer | string) { push(chunk); return true; },
    end(chunk?: Buffer | string) { push(chunk); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get headers() { return headers; },
    get bytes() { return Buffer.concat(chunks); },
  };
}

function context(workflowService?: WorkflowService): ApiContext {
  return {
    getConfig: () => ({
      gateway: {},
      engines: { default: "codex" },
      sessions: {},
      connectors: {},
      mcp: {},
    } as unknown as JinnConfig),
    connectors: new Map(),
    startTime: Date.now(),
    gatewayAuthToken: "test-token",
    emit: () => {},
    reloadOrg: () => {},
    workflowService,
    sessionManager: { getEngine: () => undefined, getEngines: () => new Map() },
  } as unknown as ApiContext;
}

/** Every request advertises both encodings, so `pickEncoding`'s brotli
 *  preference is what the assertions below are actually pinning. */
async function call(method: string, url: string, workflowService?: WorkflowService) {
  const req = Object.assign(Readable.from([]), {
    method,
    url,
    headers: { host: "localhost", "accept-encoding": "gzip, br" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const cap = captureRes();
  await handleApiRequest(req as unknown as Parameters<typeof handleApiRequest>[0], cap.res, context(workflowService));
  return cap;
}

/**
 * Group A in one place: the status is unchanged, the response declares brotli,
 * it varies on Accept-Encoding so a shared cache cannot hand compressed bytes to
 * a client that did not ask for them, and the bytes really are brotli of exactly
 * the expected JSON. The `MIN_COMPRESS_BYTES` guard is what stops this test from
 * quietly becoming a no-op: under the floor `json()` is right to skip
 * compression, so the encoding assertions would be wrong rather than failing.
 */
function expectBrotli(cap: ReturnType<typeof captureRes>, status: number, expected: unknown): void {
  const wire = JSON.stringify(expected);
  expect(Buffer.byteLength(wire)).toBeGreaterThanOrEqual(MIN_COMPRESS_BYTES);
  expect(cap.status).toBe(status);
  expect(cap.headers["content-encoding"]).toBe("br");
  expect(cap.headers["vary"]).toBe("Accept-Encoding");
  expect(zlib.brotliDecompressSync(cap.bytes).toString("utf-8")).toBe(wire);
}

// A managed file over the threshold, in the temp JINN_HOME vitest.global-setup.ts
// pins. The name is this file's own so a parallel suite cannot collide with it.
const FIXTURE_REL = "files/domain-router-response-owner-fixture.md";
const FIXTURE_TEXT = "The quick brown fox jumps over the lazy dog.\n".repeat(30);
let fixtureResolvedPath = "";

// A definition page big enough to negotiate. `listDefinitions` is a pure read, so
// a stub is honest here: the route under test is the response path, not the store.
const DEFINITION_PAGE = {
  items: Array.from({ length: 8 }, (_, i) => ({
    id: `wf_response_owner_${i}`,
    title: `Response owner workflow ${i}`,
    description: `Definition ${i} carries enough prose that the page as a whole clears the compression floor.`,
    enabled: true,
    retired: false,
    revision: i + 1,
  })),
  nextCursor: null,
};

// The cheapest large talk body there is: the 404 echoes the requested id back,
// and nothing upstream of it touches provider config or mints a credential. The
// id is long *on purpose* — that length is what carries the response past
// MIN_COMPRESS_BYTES; shorter, and the route is correctly left uncompressed.
const LONG_TALK_ID = "talk-session-that-was-never-opened-".repeat(32);

function serviceReturningDefinitions(): WorkflowService {
  return { listDefinitions: () => DEFINITION_PAGE } as unknown as WorkflowService;
}

beforeAll(() => {
  const absolute = path.resolve(FILES_DIR, path.basename(FIXTURE_REL));
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(absolute, FIXTURE_TEXT);
  // classifyFile reports the realpath and macOS's temp home is itself a symlink,
  // so the expectation has to be resolved the same way the route resolves it.
  fixtureResolvedPath = fs.realpathSync.native(absolute);
});

beforeEach(() => {
  vi.mocked(logger.error).mockClear();
});

describe("domain routers negotiate compression through the shared json helper", () => {
  it("compresses a large GET /api/files/read body", async () => {
    const cap = await call("GET", `/api/files/read?path=${FIXTURE_REL}`);

    expectBrotli(cap, 200, {
      path: FIXTURE_REL,
      resolvedPath: fixtureResolvedPath,
      mime: "text/markdown",
      size: Buffer.byteLength(FIXTURE_TEXT),
      tooLarge: false,
      binary: false,
      content: FIXTURE_TEXT,
    });
  });

  it("compresses a large GET /api/workflows definition page", async () => {
    const cap = await call("GET", "/api/workflows", serviceReturningDefinitions());

    expectBrotli(cap, 200, DEFINITION_PAGE);
  });

  it("compresses a large GET /api/talk/sessions/:id response", async () => {
    const cap = await call("GET", `/api/talk/sessions/${LONG_TALK_ID}`);

    expectBrotli(cap, 404, {
      error: `Talk session ${LONG_TALK_ID} does not exist: it was closed or never opened.`,
    });
  });
});

describe("workflow-api reports the cause it hides behind its 500 envelope", () => {
  it("keeps the internal-error body and logs the discarded error", async () => {
    const boom = "workflow definition store exploded";
    const service = {
      listDefinitions: () => { throw new Error(boom); },
    } as unknown as WorkflowService;

    const cap = await call("GET", "/api/workflows", service);

    // The envelope is deliberately fixed: an unexpected failure must not leak an
    // internal message to the client. Pinning it is what makes the assertion
    // below safe — the fix has to be a log line, never a widened response.
    expect(cap.status).toBe(500);
    expect(JSON.parse(cap.bytes.toString("utf-8"))).toEqual({
      code: "internal-error",
      message: "Workflow operation failed.",
    });

    // Without this the cause dies at the boundary: an operator reading
    // "Workflow operation failed." has nothing that says what actually threw.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(boom));
  });
});
