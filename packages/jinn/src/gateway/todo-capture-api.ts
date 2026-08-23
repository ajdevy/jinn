import crypto from "node:crypto";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { createSession, getMessages, getSession, insertMessage, listSessionsByWorkItem, updateSession } from "../sessions/registry.js";
import { enqueueQueueItem } from "../sessions/queue-item-registry.js";
import { listWorkItems } from "../work-items/store.js";
import { readJsonBody } from "./http-helpers.js";
import { orgRegistry } from "./org-registry.js";
import { badRequest, json, matchRoute, serverError, type ParsedRoute } from "./route-helpers.js";
import { resolveMessageAudiences } from "./speech-context.js";
import { preflightSystemEmployee } from "./system-employee-spawn.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "./system-employees.js";
import { deriveTodoCaptureState, type TodoCaptureFacts, type TodoCaptureState, type TodoCaptureTodoFact } from "./todo-capture-stage.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import type { ApiContext } from "./api.js";

/**
 * Quick capture: one rough sentence in, one shaping session out.
 *
 * The POST is the whole autonomous half of the feature — it spawns the Todo
 * Shaper on the operator's raw text and returns immediately. The GET answers
 * how far that capture has got, and answers it by DERIVING the stage from real
 * state (see todo-capture-stage.ts) rather than reading a stage anyone wrote
 * down. That is what makes a reload recover, and what makes it impossible for
 * the strip to show progress the system has not made.
 *
 * The spawn deliberately follows the Todo Dispatcher route's recipe step for
 * step — org lookup, attachment check, engine check, createSession /
 * insertMessage / updateSession / enqueue / dispatch — because the two are the
 * same act and a second, subtly different spawn is how one of them rots.
 */

const CAPTURE_TEXT_MAX = 4_000;

/** The wire shape. `captureId` is the shaping session's id: the session IS the
 *  capture, so there is no second identifier to keep in step with it, and a
 *  capture survives a restart exactly as long as its session does. */
export interface TodoCaptureWire extends TodoCaptureState {}

/** Last stage pushed for a capture, so an unchanged recompute stays quiet.
 *  Bounded by the captures a running gateway has seen; a restart clears it and
 *  the next GET re-pushes, which is the correct behaviour rather than a leak. */
const lastEmitted = new Map<string, string>();

function factsFor(captureId: string, dispatcherEmployee: string, shaperEmployee: string): TodoCaptureFacts {
  const session = getSession(captureId);
  // `listWorkItems` orders for the board, not by age. The capture's Todo is the
  // FIRST one its session made, so age is what this needs.
  const todos = listWorkItems({ createdBy: `session:${captureId}` })
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return {
    captureId,
    session: session
      ? {
        id: session.id,
        status: session.status,
        // "The engine has said something" is the only honest difference between
        // a session that has started and one that is working.
        spoke: getMessages(session.id).some((message) => message.role === "assistant"),
        attemptOutcome: session.attemptOutcome ?? null,
        lastError: session.lastError ?? null,
      }
      : null,
    todos: todos.map((item): TodoCaptureTodoFact => ({
      id: item.id,
      title: item.title,
      linked: listSessionsByWorkItem(item.id).map((linked) => ({
        id: linked.id,
        employee: linked.employee,
        workflowId: linked.workflowProvenance?.workflowId ?? null,
        workflowName: linked.workflowProvenance?.workflowName ?? null,
        workflowRunId: linked.workflowProvenance?.runId ?? null,
      })),
    })),
    dispatcherEmployee,
    shaperEmployee,
  };
}

/** Derive, and push only when the answer moved. The GET stays the source of
 *  truth; this event only saves the browser from polling for a change that has
 *  not happened yet. */
export function refreshTodoCapture(context: ApiContext, captureId: string): TodoCaptureState {
  const state = deriveTodoCaptureState(factsFor(captureId, TODO_DISPATCHER_NAME, TODO_SHAPER_NAME));
  const signature = `${state.stage}:${state.workItemId ?? ""}:${state.error ?? ""}`;
  if (lastEmitted.get(captureId) !== signature) {
    lastEmitted.set(captureId, signature);
    context.emit("todo-capture:stage", {
      captureId,
      stage: state.stage,
      workItemId: state.workItemId,
    });
  }
  return state;
}

function capturePrompt(text: string): string {
  return [
    "A capture was thrown at the Todos board. Shape it into one well-formed Todo, then hand it off.",
    "",
    "Capture:",
    text,
  ].join("\n");
}

/** The capture itself, or a refusal already written to the response. */
async function readCapture(
  req: HttpRequest,
  res: ServerResponse,
): Promise<{ text: string; speechDerived: boolean } | undefined> {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return undefined;
  const body = (parsed.body ?? {}) as { text?: unknown; speechDerived?: unknown };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    badRequest(res, "text is required — a capture with nothing in it has nothing to shape");
    return undefined;
  }
  if (text.length > CAPTURE_TEXT_MAX) {
    badRequest(res, `text is ${text.length} characters; the cap is ${CAPTURE_TEXT_MAX}. Use the full Todo form for something this long.`);
    return undefined;
  }
  return { text, speechDerived: body.speechDerived === true };
}

async function startCapture(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const capture = await readCapture(req, res);
  if (!capture) return;
  const { text, speechDerived } = capture;

  const config = context.getConfig();
  const shaper = orgRegistry(config).get(TODO_SHAPER_NAME);
  if (!shaper?.system) return serverError(res, "the built-in Todo Shaper is unavailable");

  // The same two questions the Dispatcher route asks, answered in the same
  // words: a Shaper that cannot attach the company tools cannot create a Todo,
  // so starting it would spend a turn to achieve nothing.
  const preflight = preflightSystemEmployee({
    employee: shaper, label: "Todo Shaper", settingLabel: "Todo Shaper",
    engineName: shaper.engine, globalMcp: config.mcp,
    getEngine: (name) => context.sessionManager.getEngine(name),
  });
  if (!preflight.ok) return json(res, { error: preflight.error }, preflight.status);

  const prompt = capturePrompt(text);
  // A voice capture is a transcription and may be misheard. The Shaper is told
  // so on the engine side only; the operator's own words are what gets stored.
  const { visible, engine: enginePrompt } = resolveMessageAudiences(prompt, speechDerived);
  const sessionKey = `todo-shaper:${crypto.randomUUID()}`;
  const session = createSession({
    engine: shaper.engine,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    employee: shaper.name,
    model: shaper.model,
    effortLevel: shaper.effortLevel,
    prompt: visible,
    title: "Quick capture",
    portalName: config.portal?.portalName,
  });
  insertMessage(session.id, "user", visible);
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() });
  session.status = "running";

  const queueItemId = enqueueQueueItem(session.id, sessionKey, visible, { dispatch: { attachments: [], speechDerived } });
  context.emit("queue:updated", { sessionId: session.id, sessionKey });
  dispatchWebSessionRun(session, enginePrompt, preflight.engine, context, { queueItemId });

  return json(res, refreshTodoCapture(context, session.id), 201);
}

export async function handleTodoCaptureApi(
  req: HttpRequest,
  res: ServerResponse,
  route: ParsedRoute,
  context: ApiContext,
): Promise<boolean> {
  if (route.method === "POST" && route.pathname === "/api/todo-captures") {
    await startCapture(req, res, context);
    return true;
  }

  const params = matchRoute("/api/todo-captures/:id", route.pathname);
  if (route.method === "GET" && params) {
    if (!getSession(params.id)) {
      return json(res, { error: `capture ${params.id} not found` }, 404), true;
    }
    return json(res, refreshTodoCapture(context, params.id)), true;
  }

  return false;
}
