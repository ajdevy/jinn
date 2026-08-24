import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { api, ApiError, type TodoCaptureWire } from "@/lib/api"
import { useGateway } from "@/hooks/use-gateway"
import { foldCaptureSteps, type CaptureStep } from "./capture-stages"

/**
 * One capture, from submit to terminal line.
 *
 * The server's GET is the only source of truth for how far a capture has got —
 * `todo-capture:stage` is a nudge to re-read it, never the state itself. That
 * split is what makes a reload recover: the hook holds no stage the server
 * could not tell it again.
 *
 * Telling the board behind the bar is the same story told once more: the board
 * is a cache of Todos that stops matching reality the moment the Shaper makes
 * one, so `absorb` invalidates the `work-items` query and stops there. That IS
 * the notification — the board re-reads through the same query every other
 * writer refreshes it with, so no callback has to be threaded down to it.
 */

export interface TodoCaptureRun {
  steps: CaptureStep[]
  state: TodoCaptureWire | null
  /** The server's own words. Never a message this hook invented. */
  error: string | null
  pending: boolean
  settled: boolean
}

const EMPTY: TodoCaptureRun = { steps: [], state: null, error: null, pending: false, settled: false }

function nextRun(prev: TodoCaptureRun, state: TodoCaptureWire): TodoCaptureRun {
  return {
    steps: foldCaptureSteps(prev.steps, state),
    state,
    error: state.stage === "failed" ? state.error : null,
    pending: false,
    settled: state.stage === "failed" || state.stage === "routed" || state.stage === "landed",
  }
}

/** Re-read on the frames that actually move a capture: its own stage event, the
 *  Todo appearing, and the shaping session settling. */
function useCaptureFrames(captureId: React.RefObject<string | null>, reread: () => void) {
  const { subscribe } = useGateway()
  useEffect(() => subscribe((frame) => {
    if (frame.event === "todo-capture:stage") {
      if (frame.payload.captureId === captureId.current) reread()
      return
    }
    if (!captureId.current) return
    if (frame.event === "company:changed" && frame.payload.entity === "todo") reread()
    if (frame.event === "session:completed" || frame.event === "session:updated") reread()
  }), [subscribe, reread, captureId])
}

export function useTodoCapture() {
  const [run, setRun] = useState<TodoCaptureRun>(EMPTY)
  const qc = useQueryClient()
  // A capture spawns a session and spends money, so "posted once" is a
  // correctness property, not a nicety: this latch is what makes a double
  // Enter, or a re-render mid-flight, unable to start a second Shaper.
  const posting = useRef(false)
  const captureId = useRef<string | null>(null)
  const announcedTodo = useRef<string | null>(null)

  const absorb = useCallback((state: TodoCaptureWire) => {
    setRun((prev) => nextRun(prev, state))
    // Once per Todo, which is what the ref is for.
    if (state.workItemId && announcedTodo.current !== state.workItemId) {
      announcedTodo.current = state.workItemId
      void qc.invalidateQueries({ queryKey: ["work-items"] })
    }
  }, [qc])

  const reread = useCallback(() => {
    const id = captureId.current
    if (!id) return
    // A failed re-read is not a failed capture: the next frame re-reads, and the
    // strip keeps the last state the server actually confirmed.
    void api.getTodoCapture(id).then(absorb).catch(() => {})
  }, [absorb])

  const start = useCallback(async (text: string, speechDerived: boolean) => {
    if (posting.current || captureId.current) return
    posting.current = true
    setRun({ steps: ["captured"], state: null, error: null, pending: true, settled: false })
    try {
      const state = await api.startTodoCapture({ text, speechDerived })
      captureId.current = state.captureId
      absorb(state)
    } catch (error) {
      // The gateway's reason, verbatim. A capture that could not start says why;
      // it never says "something went wrong".
      const reason = error instanceof ApiError ? error.message : String(error)
      setRun({ steps: ["captured"], state: null, error: reason, pending: false, settled: true })
    } finally {
      posting.current = false
    }
  }, [absorb])

  useCaptureFrames(captureId, reread)

  return { run, start }
}
