import crypto from "node:crypto";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { createSession, getMessages, getSession, insertMessage, listSessionsByWorkItem, updateSession } from "../sessions/registry.js";
import { enqueueQueueItem } from "../sessions/queue-item-registry.js";
import { getWorkItem, linkSession, listWorkItems } from "../work-items/store.js";
import { logger } from "../shared/logger.js";
import { readJsonBody } from "./http-helpers.js";
import { sourceSessionId } from "./approval-authority.js";
import { resolveCallerIdentity } from "./session-comm-guards.js";
import { UNIDENTIFIED_TOOL_CALL_ERROR, verifySessionCapability } from "../mcp/identity.js";
import { isTodoId } from "../work-items/id.js";
import { orgRegistry } from "./org-registry.js";
import { json, matchRoute, serverError, type ParsedRoute } from "./route-helpers.js";
import { resolveMessageAudiences } from "./speech-context.js";
import { preflightSystemEmployee } from "./system-employee-spawn.js";
import { TODO_DISPATCHER_NAME, TODO_SHAPER_NAME } from "./system-employees.js";
import { deriveTodoCaptureState, type TodoCaptureFacts, type TodoCaptureState, type TodoCaptureTodoFact } from "./todo-capture-stage.js";
import { dispatchWebSessionRun } from "./web-session-dispatch.js";
import type { Employee, Engine } from "../shared/types.js";
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

/**
 * The Todo a capture landed ON, if it landed anywhere.
 *
 * A capture that restated an existing Todo creates nothing, so there is no Todo
 * of its own to read. What it leaves instead is a link from its OWN session to
 * the Todo it restated — one field on the session object the caller already
 * holds. `land_on_work_item` is the only thing that writes it on a shaping
 * session, which is what makes reading it a fact rather than a guess about what
 * the Shaper's comment meant.
 *
 * Todos the capture created itself are excluded: those are answered by the
 * ladder, and a capture linked to its own Todo has not restated anything.
 */
function landedWorkItem(
  session: ReturnType<typeof getSession>,
  created: readonly { id: string }[],
): { id: string; title: string } | null {
  const landedId = session?.workItemId;
  if (!landedId || created.some((item) => item.id === landedId)) return null;
  const item = getWorkItem(landedId);
  return item ? { id: item.id, title: item.title } : null;
}

function factsFor(captureId: string, dispatcherEmployee: string, shaperEmployee: string): TodoCaptureFacts {
  const session = getSession(captureId);
  // Narrow in SQL to Todos this employee made from a session, then match the
  // exact capture on provenance. `createdBy` records the EMPLOYEE, so it cannot
  // tell two captures apart — `sourceRef` names the session, and is the same
  // link the dispatch authority walk reads.
  //
  // `listWorkItems` orders for the board, not by age. The capture's Todo is the
  // FIRST one its session made, so age is what this needs.
  const todos = listWorkItems({ source: "session", createdBy: shaperEmployee })
    .filter((item) => sourceSessionId(item) === captureId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  return {
    captureId,
    landedWorkItem: landedWorkItem(session, todos),
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

/** Both halves of the honesty contract at once: the operator sees the reason in
 *  the strip, and the same sentence lands in the gateway log. A refusal that
 *  only ever existed in one HTTP response is not diagnosable after the fact. */
function refuse(res: ServerResponse, status: number, error: string): void {
  logger.warn(`Quick capture refused (${status}): ${error}`);
  json(res, { error }, status);
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
    refuse(res, 400, "text is required — a capture with nothing in it has nothing to shape");
    return undefined;
  }
  if (text.length > CAPTURE_TEXT_MAX) {
    refuse(res, 400, `text is ${text.length} characters; the cap is ${CAPTURE_TEXT_MAX}. Use the full Todo form for something this long.`);
    return undefined;
  }
  return { text, speechDerived: body.speechDerived === true };
}

/** The Shaper and a live engine for it, or a refusal already written. */
function readyShaper(
  res: ServerResponse,
  context: ApiContext,
  config: ReturnType<ApiContext["getConfig"]>,
): { shaper: Employee; engine: Engine } | undefined {
  const shaper = orgRegistry(config).get(TODO_SHAPER_NAME);
  if (!shaper?.system) {
    const error = "the built-in Todo Shaper is unavailable";
    logger.warn(`Quick capture refused (500): ${error}`);
    serverError(res, error);
    return undefined;
  }
  // The same two questions the Dispatcher route asks, answered in the same
  // words: a Shaper that cannot attach the company tools cannot create a Todo,
  // so starting it would spend a turn to achieve nothing.
  const preflight = preflightSystemEmployee({
    employee: shaper, label: "Todo Shaper", settingLabel: "Todo Shaper",
    engineName: shaper.engine, globalMcp: config.mcp,
    getEngine: (name) => context.sessionManager.getEngine(name),
  });
  if (!preflight.ok) {
    refuse(res, preflight.status, preflight.error);
    return undefined;
  }
  return { shaper, engine: preflight.engine };
}

async function startCapture(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const capture = await readCapture(req, res);
  if (!capture) return;
  const { text, speechDerived } = capture;

  const config = context.getConfig();
  const ready = readyShaper(res, context, config);
  if (!ready) return;
  const { shaper, engine } = ready;

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
  dispatchWebSessionRun(session, enginePrompt, engine, context, { queueItemId });

  return json(res, refreshTodoCapture(context, session.id), 201);
}

/**
 * A capture that restated a Todo the board already had.
 *
 * It lives beside the capture routes rather than among the work-item ones
 * because it is a fact about a CAPTURE — it is the third way one can end, and
 * `factsFor` above is its only reader. The route is essentially one call:
 * `linkSession` is what turns "the Shaper said this was a duplicate" from prose
 * in a comment into something the derived stage is allowed to read, and it
 * already appends the `session_linked` audit event.
 *
 * Session callers only. The operator has no capture to land, and an operator
 * link here would put a stage on a capture that never claimed it.
 */
function recordCaptureLanding(req: HttpRequest, res: ServerResponse, todoId: string): boolean {
  const identity = resolveCallerIdentity(req.headers, {
    sessionExists: (sessionId) => !!getSession(sessionId),
    verifySessionCapability,
    requireCapability: true,
  });
  if (identity.kind !== "session") {
    const error = identity.kind === "unidentified-tool"
      ? UNIDENTIFIED_TOOL_CALL_ERROR
      : "capture-landing records where a session's own capture landed, so it needs a session caller";
    return json(res, { error }, 403), true;
  }
  if (!isTodoId(todoId)) {
    return json(res, { error: "Invalid Todo ID; expected <AAA>-N with a positive safe-integer suffix" }, 400), true;
  }
  const item = getWorkItem(todoId);
  if (!item) return json(res, { error: `Todo ${todoId} not found` }, 404), true;
  try {
    linkSession(item.id, identity.callerId, getSession(identity.callerId)?.employee ?? null);
  } catch (error) {
    return serverError(res, `capture landing on ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`), true;
  }
  return json(res, { workItemId: item.id, workItemTitle: item.title, sessionId: identity.callerId }), true;
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

  const landing = matchRoute("/api/work-items/:id/capture-landing", route.pathname);
  if (route.method === "POST" && landing) return recordCaptureLanding(req, res, landing.id);

  const params = matchRoute("/api/todo-captures/:id", route.pathname);
  if (route.method === "GET" && params) {
    if (!getSession(params.id)) {
      return json(res, { error: `capture ${params.id} not found` }, 404), true;
    }
    return json(res, refreshTodoCapture(context, params.id)), true;
  }

  return false;
}
