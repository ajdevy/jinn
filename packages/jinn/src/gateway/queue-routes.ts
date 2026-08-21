// The operator surface over a session's durable turn queue. Split out of
// api.ts, which carries these routes' history and is at its size baseline.
import type { ServerResponse } from "node:http";
import { cancelAllPendingQueueItems, cancelQueueItem, getQueueItems, getSession } from "../sessions/registry.js";
import type { Session } from "../shared/types.js";
import { json, matchRoute, notFound } from "./route-helpers.js";
import type { ApiContext } from "./api.js";

/** The queue is keyed by session key, not session id: a resumed session keeps its rows. */
function queueKey(session: Session): string {
  return session.sessionKey || session.sourceRef || session.id;
}

interface QueueRouteArgs {
  res: ServerResponse;
  context: ApiContext;
  session: Session;
  params: Record<string, string>;
}

function cancelOneItem({ res, context, session, params }: QueueRouteArgs): void {
  if (!cancelQueueItem(params.itemId)) {
    return json(res, { error: "Item not found or already running" }, 409);
  }
  context.emit("queue:updated", { sessionId: params.id, sessionKey: session.sessionKey });
  return json(res, { status: "cancelled", itemId: params.itemId });
}

function listItems({ res, session }: QueueRouteArgs): void {
  return json(res, getQueueItems(queueKey(session)));
}

function clearPendingItems({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  // Cancel only operator-visible rows. SessionQueue checks each durable row
  // before execution, so no coarse in-memory cancellation is needed here;
  // setting one would also discard protected internal callback rows.
  const cancelled = cancelAllPendingQueueItems(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
  return json(res, { status: "cleared", cancelled });
}

function pause({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  context.sessionManager.getQueue().pauseQueue(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
  return json(res, { status: "paused", sessionId: params.id });
}

function resume({ res, context, session, params }: QueueRouteArgs): void {
  const sessionKey = queueKey(session);
  context.sessionManager.getQueue().resumeQueue(sessionKey);
  context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
  return json(res, { status: "resumed", sessionId: params.id });
}

/**
 * Most specific first: `/queue/:itemId` also matches `/queue/pause`, so only the
 * method keeps those two apart.
 */
const QUEUE_ROUTES: Array<{ method: string; pattern: string; run: (args: QueueRouteArgs) => void }> = [
  { method: "DELETE", pattern: "/api/sessions/:id/queue/:itemId", run: cancelOneItem },
  { method: "GET", pattern: "/api/sessions/:id/queue", run: listItems },
  { method: "DELETE", pattern: "/api/sessions/:id/queue", run: clearPendingItems },
  { method: "POST", pattern: "/api/sessions/:id/queue/pause", run: pause },
  { method: "POST", pattern: "/api/sessions/:id/queue/resume", run: resume },
];

/** Returns false when the request is not a queue route, so api.ts keeps matching. */
export function handleSessionQueueRoute(
  method: string,
  pathname: string,
  res: ServerResponse,
  context: ApiContext,
): boolean {
  for (const route of QUEUE_ROUTES) {
    if (route.method !== method) continue;
    const params = matchRoute(route.pattern, pathname);
    if (!params) continue;
    const session = getSession(params.id);
    if (!session) notFound(res);
    else route.run({ res, context, session, params });
    return true;
  }
  return false;
}
