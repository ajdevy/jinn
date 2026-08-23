/**
 * Quick capture: start one, and read how far it has got.
 *
 * The GET is the source of truth for a capture's stage — the gateway derives it
 * from real state on every read, so the browser holds nothing it could not be
 * told again, and a reload recovers a capture already in flight.
 */

export type TodoCaptureStageWire =
  | "starting"
  | "shaping"
  | "created"
  | "dispatching"
  | "routed"
  | "landed"
  | "failed"

export type TodoCaptureRouteWire =
  | { kind: "workflow"; workflowId: string; workflowName: string | null; runId: string | null }
  | { kind: "employee"; employee: string; sessionId: string }

export interface TodoCaptureWire {
  captureId: string
  sessionId: string | null
  stage: TodoCaptureStageWire
  /** On `landed` this names the Todo the capture RESTATED rather than one it
   *  created — the operator's question is the same either way: where did it go. */
  workItemId: string | null
  workItemTitle: string | null
  routedTo: TodoCaptureRouteWire | null
  /** A capture is one Todo; anything extra it made is reported, not hidden. */
  extraWorkItemIds: string[]
  /** Set only on `failed`, and always the gateway's real reason. */
  error: string | null
}

export interface TodoCaptureHttp {
  get: <T>(path: string) => Promise<T>
  post: <T>(path: string, body?: unknown) => Promise<T>
}

/** The quick-capture slice of the `api` object. */
export function createTodoCaptureApi({ get, post }: TodoCaptureHttp) {
  return {
    startTodoCapture: (input: { text: string; speechDerived?: boolean }) =>
      post<TodoCaptureWire>("/api/todo-captures", input),
    getTodoCapture: (captureId: string) =>
      get<TodoCaptureWire>(`/api/todo-captures/${encodeURIComponent(captureId)}`),
  }
}
