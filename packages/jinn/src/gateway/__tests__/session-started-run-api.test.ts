import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand } from "../../shared/types.js";
import type { WorkflowSessionExecutor } from "../../workflows/session-executor.js";
import type { ApiContext } from "../api.js";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";

// paths.js freezes JINN_HOME as it is imported, so the home is redirected here,
// at module scope, and everything that reaches it is imported dynamically below.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-started-run-api-home-"));
process.env.JINN_HOME = home;

type Api = typeof import("../api.js");
type Registry = typeof import("../../sessions/registry.js");
type Migrations = typeof import("../../workflows/repository-migrations.js");
type Repository = typeof import("../../workflows/repository.js");
type Service = typeof import("../../workflows/service.js");

let handleApiRequest: Api["handleApiRequest"];
let createSession: Registry["createSession"];
let openWorkflowDatabase: Migrations["openWorkflowDatabase"];
let WorkflowRepository: Repository["WorkflowRepository"];
let WorkflowService: Service["WorkflowService"];

beforeAll(async () => {
  ({ handleApiRequest } = await import("../api.js"));
  ({ createSession } = await import("../../sessions/registry.js"));
  ({ openWorkflowDatabase } = await import("../../workflows/repository-migrations.js"));
  ({ WorkflowRepository } = await import("../../workflows/repository.js"));
  ({ WorkflowService } = await import("../../workflows/service.js"));
});

const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
  engine: "test-engine", model: "model-a", effortLevel: "high", persona: "Executes work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "model-a",
  effortMechanism: "codex-config",
  models: [{ id: "model-a", label: "Model A", supportsEffort: true, effortLevels: ["high"] }] } };

function request(url: string, body: unknown, sessionId?: string) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: "POST",
    url,
    headers: { host: "localhost", authorization: "Bearer test-token", "content-type": "application/json",
      ...(sessionId === undefined ? {} : {
        [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
        [CALLER_SESSION_HEADER]: sessionId,
        [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
      }) },
  });
  return req as unknown as Parameters<typeof handleApiRequest>[0];
}

function response() {
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

describe("POST /api/workflows/:id/runs from an attempt session", () => {
  it("refuses recursion with a structured 422 and starts nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-started-run-api-"));
    const database = openWorkflowDatabase(path.join(root, "workflows.db"));
    const repository = new WorkflowRepository(database);
    let attemptSessionId = "";
    const executor = {
      subscribe: () => () => undefined,
      async startAttempt(command: WorkflowAttemptCommand) {
        const session = createSession({ engine: command.engine, source: "web",
          sourceRef: `workflow:${command.owner.runId}:${command.owner.nodeId}`, title: "Workflow attempt" });
        attemptSessionId = session.id;
        return { sessionId: session.id };
      },
      async stopAttempt() {},
      readTerminalCompletion: () => null,
    } as unknown as WorkflowSessionExecutor;
    const service = new WorkflowService({ repository, executor,
      employees: () => new Map([[employee.name, employee]]), models: () => models });
    const context = { gatewayAuthToken: "test-token", workflowService: service, getConfig: () => ({ gateway: {}, engines: {} }),
      connectors: new Map(), sessionManager: { getQueue: () => ({}) }, emit: vi.fn(), startTime: 1 } as unknown as ApiContext;
    try {
      const created = service.createDefinition({ id: "loop-flow", title: "Loop flow" });
      const saved = service.saveDefinition({ ...created, nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
        { id: "work", type: "employee", name: "Work", config: {
          employee: { source: "fixed", value: "worker" }, prompt: "Start another run." } },
        { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ], edges: [
        { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
        { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
      ] }, created.revision);
      service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
      await service.startManual({ workflowId: saved.id, input: {} });

      const refused = response();
      await handleApiRequest(request("/api/workflows/loop-flow/runs", { input: {} }, attemptSessionId),
        refused.res, context);

      expect(refused.read()).toEqual({
        status: 422,
        body: { code: "bad-input", message: "Workflow call recursion is not allowed." },
      });
      expect(service.listRuns(saved.id, {}).items).toHaveLength(1);
    } finally {
      service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
