import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-config-known-keys-"));
const jinnHome = path.join(root, "instance");
process.env.JINN_HOME = jinnHome;
fs.mkdirSync(jinnHome, { recursive: true });

type Api = typeof import("../api.js");

let api: Api;
let currentConfig: JinnConfig;

function baseConfig(): JinnConfig {
  return {
    gateway: {},
    engines: { default: "codex", claude: {} },
    connectors: {},
    logging: { file: false, stdout: false, level: "info" },
  } as unknown as JinnConfig;
}

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    setHeader() {
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method,
    url,
    headers: {
      host: "localhost",
      authorization: "Bearer test-token",
      ...(raw ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
  });
  const capture = makeResponse();
  await api.handleApiRequest(
    req as unknown as Parameters<Api["handleApiRequest"]>[0],
    capture.res,
    {
      gatewayAuthToken: "test-token",
      jinnHome,
      getConfig: () => currentConfig,
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: { getEngines: () => new Map(), getEngine: () => undefined },
    } as unknown as import("../api.js").ApiContext,
  );
  return capture;
}

function savedConfig(): Record<string, any> {
  return yaml.load(fs.readFileSync(path.join(jinnHome, "config.yaml"), "utf-8")) as Record<string, any>;
}

beforeAll(async () => {
  api = await import("../api.js");
});

beforeEach(() => {
  currentConfig = baseConfig();
  fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("PUT /api/config top-level key allowlist", () => {
  it("accepts and persists the workflows block", async () => {
    const response = await call("PUT", "/api/config", {
      workflows: { armingDelegates: ["platform-delegate"] },
    });

    expect(response.status).toBe(200);
    expect(savedConfig().workflows).toEqual({ armingDelegates: ["platform-delegate"] });
  });

  it("round-trips a gateway configured with arming delegates", async () => {
    currentConfig = { ...baseConfig(), workflows: { armingDelegates: ["platform-delegate"] } };
    fs.writeFileSync(path.join(jinnHome, "config.yaml"), yaml.dump(currentConfig));

    const fetched = await call("GET", "/api/config");
    expect(fetched.status).toBe(200);

    const saved = await call("PUT", "/api/config", fetched.body);
    expect(saved.status).toBe(200);
    expect(savedConfig().workflows).toEqual({ armingDelegates: ["platform-delegate"] });
  });

  it("still refuses a key JinnConfig does not declare", async () => {
    const response = await call("PUT", "/api/config", { nonsense: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unknown config keys: nonsense");
  });
});
