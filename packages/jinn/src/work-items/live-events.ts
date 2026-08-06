import type { JsonObject } from "../shared/types.js";
import type { WorkItem } from "./store.js";

/**
 * ICI-570 — live change signal for Todo writes that happen IN-PROCESS, outside
 * the HTTP routes: the cron mint, and (ICI-749) every guarded status write,
 * whoever commits it. This module gives the gateway one registration point so
 * those lanes reach the web dashboard too. The non-status route lanes still emit
 * their own richer `company:changed` events at the persistence boundary. Null
 * (the default, and the state in tests/CLI runs without a server) makes every
 * notify a no-op.
 */

export interface TodoLiveEvent {
  entity: "todo";
  action: string;
  id: string;
  version: number;
  value?: JsonObject;
  /** The session that invoked the write, when one did. The client refetches its
   *  transcript as loss recovery for a dropped activity block. */
  sessionId?: string;
}

type TodoLiveEmitter = (event: TodoLiveEvent) => void;

let emitter: TodoLiveEmitter | null = null;

export function setTodoLiveEmitter(next: TodoLiveEmitter | null): void {
  emitter = next;
}

export function notifyTodoChanged(item: WorkItem, action: string, sessionId?: string): void {
  if (!emitter) return;
  try {
    emitter({
      entity: "todo",
      action,
      id: item.id,
      version: item.version,
      value: item as unknown as JsonObject,
      ...(sessionId ? { sessionId } : {}),
    });
  } catch {
    // A broken listener must never fail the write it observes.
  }
}
