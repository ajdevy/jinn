import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { JinnConfig } from "../../shared/types.js";

/**
 * ICI-733 at the two places a Todo becomes a working session: the built-in
 * Dispatcher and a delegation.
 *
 * What is being proved is that the Todo's own dispatch preferences reach the
 * attempt — the requested skills arrive in the prompt, and the engine/model
 * override wins over both the request and the employee's configured default.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-dispatch-config-route-"));
process.env.JINN_HOME = home;
fs.mkdirSync(path.join(home, "org"), { recursive: true });
fs.writeFileSync(
  path.join(home, "org", "route-worker.yaml"),
  [
    "name: route-worker",
    "displayName: Route Worker",
    "department: platform",
    "rank: employee",
    "engine: codex",
    "model: gpt-5.6-sol",
    "persona: Completes bounded route work",
    "",
  ].join("\n"),
);
const skillsDir = path.join(home, "skills");
for (const name of ["dev-workflow", "browser-use"]) {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

const dbModule = await import("../../shared/db.js");

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type WorkItems = typeof import("../../work-items/store.js");

let api: Api;
let registry: Registry;
let workItems: WorkItems;

const engineStub = {
  name: "stub",
  // Every dispatched session hangs, so a started attempt stays inspectable.
  run: async () => new Promise(() => {}),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};

const queueStub = {
  enqueue: async (_key: string, fn: () => Promise<void>) => fn(),
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};

function config(): JinnConfig {
  return {
    gateway: { port: 7799, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }, { id: "sonnet", supportsEffort: false }] },
      codex: {
        default: "gpt-5.6-sol",
        models: [
          { id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    mcp: { gateway: { enabled: true } },
  } as unknown as JinnConfig;
}

const context = {
  getConfig: config,
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  reloadOrg: () => {},
  sessionManager: {
    getEngine: () => engineStub,
    getEngines: () => new Map(),
    getQueue: () => queueStub,
  },
} as unknown as import("../api.js").ApiContext;

function makeResponse() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(nextStatus: number) { status = nextStatus; return this; },
    setHeader() { return this; },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body(): any {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : undefined;
    },
  };
}

async function call(method: string, url: string, body?: unknown) {
  const request = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json" },
    },
  );
  const captured = makeResponse();
  await api.handleApiRequest(
    request as unknown as Parameters<Api["handleApiRequest"]>[0],
    captured.res,
    context,
  );
  return { status: captured.status, body: captured.body };
}

/** The prompt the attempt actually received. */
function firstUserMessage(sessionId: string): string {
  return registry.getMessages(sessionId).find((message) => message.role === "user")?.content ?? "";
}

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  workItems = await import("../../work-items/store.js");
  dbModule.initDb();
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate({ ok: true });
});

afterAll(async () => {
  const { setJinnAttachGate } = await import("../../mcp/attachment.js");
  setJinnAttachGate(null);
});

describe("PUT /api/work-items/:id/dispatch-config", () => {
  it("rejects an unknown skill by name and writes nothing", async () => {
    const item = workItems.createWorkItem({ title: "unknown skill via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["nope-not-installed"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("nope-not-installed");
    const read = await call("GET", `/api/work-items/${item.id}`);
    expect(read.body.dispatchConfig).toBeNull();
  });

  it("rejects an MCP tool id with a message that distinguishes skills from tools", async () => {
    const item = workItems.createWorkItem({ title: "tool id via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["mcp__jinn__get_work_item"] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/MCP tool/i);
    expect(response.body.error).toContain("SKILL.md");
  });

  it("rejects an engine override whose model that engine does not know", async () => {
    const item = workItems.createWorkItem({ title: "bad model via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "gpt-5.6-sol" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("gpt-5.6-sol");
  });

  it("persists a valid config and returns it on the Todo", async () => {
    const item = workItems.createWorkItem({ title: "valid config via route", source: "human" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, {
      skills: ["dev-workflow"], engine: "claude", model: "sonnet",
    });

    expect(response.status).toBe(200);
    const read = await call("GET", `/api/work-items/${item.id}`);
    expect(read.body.dispatchConfig).toMatchObject({ skills: ["dev-workflow"], engine: "claude", model: "sonnet" });
  });

  it("is accepted while the Todo is executing", async () => {
    const item = workItems.createWorkItem({ title: "executing config", source: "human", status: "executing" });

    const response = await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    expect(response.status).toBe(200);
    expect(workItems.getWorkItem(item.id)?.status).toBe("executing");
  });
});

describe("POST /api/work-items/:id/dispatch reads the Todo's dispatch config", () => {
  it("puts the requested skills in the prompt and runs on the overridden engine", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, {
      skills: ["dev-workflow", "browser-use"], engine: "claude", model: "sonnet",
    });

    const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

    expect(dispatched.status).toBe(201);
    const prompt = firstUserMessage(dispatched.body.sessionId);
    expect(prompt).toContain("skills/dev-workflow/SKILL.md");
    expect(prompt).toContain("skills/browser-use/SKILL.md");
    // The Todo's own brief still follows the preamble.
    expect(prompt).toContain(`Dispatch Todo ${item.id}.`);
    expect(registry.getSession(dispatched.body.sessionId)).toMatchObject({ engine: "claude", model: "sonnet" });
  });

  it("refuses the dispatch when every requested skill has been uninstalled, and starts nothing", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with vanished skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["browser-use"] });
    const sessionsBefore = registry.countSessions();

    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(home, "vanished-browser-use"));
    try {
      const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

      expect(dispatched.status).toBe(409);
      expect(dispatched.body.error).toContain("browser-use");
      expect(registry.countSessions()).toBe(sessionsBefore);
    } finally {
      fs.renameSync(path.join(home, "vanished-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });

  it("dispatches on the surviving skills when only some are gone", async () => {
    const item = workItems.createWorkItem({ title: "dispatch with one skill gone", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["dev-workflow", "browser-use"] });

    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(home, "partly-gone-browser-use"));
    try {
      const dispatched = await call("POST", `/api/work-items/${item.id}/dispatch`, {});

      expect(dispatched.status).toBe(201);
      const prompt = firstUserMessage(dispatched.body.sessionId);
      expect(prompt).toContain("skills/dev-workflow/SKILL.md");
      expect(prompt).not.toContain("browser-use");
    } finally {
      fs.renameSync(path.join(home, "partly-gone-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });
});

describe("POST /api/delegations reads the Todo's dispatch config", () => {
  it("runs the delegate on the Todo's engine, beating the employee's configured default", async () => {
    const item = workItems.createWorkItem({ title: "delegate over employee default", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    // route-worker's YAML says codex/gpt-5.6-sol; the Todo's override wins.
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("beats an engine named in the request body too — that is the recovery lever", async () => {
    const item = workItems.createWorkItem({ title: "delegate over request body", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { engine: "claude", model: "opus" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", engine: "codex", model: "gpt-5.5", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("prefixes the delegate's brief with the Todo's skills, leaving the brief itself intact", async () => {
    const item = workItems.createWorkItem({ title: "delegate with skills", source: "human" });
    await call("PUT", `/api/work-items/${item.id}/dispatch-config`, { skills: ["dev-workflow"] });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    const prompt = firstUserMessage(delegated.body.sessionId);
    expect(prompt).toContain("skills/dev-workflow/SKILL.md");
    expect(prompt).toContain("Do the bounded work.");
  });

  it("leaves a delegation with no Todo override on the employee's own engine", async () => {
    const item = workItems.createWorkItem({ title: "delegate untouched", source: "human" });

    const delegated = await call("POST", "/api/delegations", {
      workItemId: item.id, employee: "route-worker", task: "Do the bounded work.",
    });

    expect(delegated.status).toBe(201);
    expect(registry.getSession(delegated.body.sessionId)).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
  });
});

describe("POST /api/work-items with an idempotencyKey", () => {
  it("returns the same Todo for a repeated key, and a new one for a different key", async () => {
    const first = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-1" });
    const replay = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-1" });
    const other = await call("POST", "/api/work-items", { title: "keyed create", idempotencyKey: "fire-2" });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    expect(replay.body.workItem.id).toBe(first.body.workItem.id);
    expect(other.body.workItem.id).not.toBe(first.body.workItem.id);
  });

  it("conflicts when the same key carries a different create", async () => {
    await call("POST", "/api/work-items", { title: "keyed original", idempotencyKey: "fire-3" });

    const conflict = await call("POST", "/api/work-items", { title: "keyed something else", idempotencyKey: "fire-3" });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("todo_create_idempotency_conflict");
  });
});
