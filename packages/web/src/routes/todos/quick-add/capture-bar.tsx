import { useState } from "react"
import { ArrowUp } from "lucide-react"
import { TodoDialog } from "../todo-dialog"
import { PipelineStrip } from "./pipeline-strip"
import { useTodoCapture } from "./use-todo-capture"

/**
 * Quick capture: one field, one send, nothing else.
 *
 * This is a capture surface, not a form — the whole reason it exists beside the
 * `+` is that the full form asks for decisions the operator does not have yet.
 * Everything the Todo needs (title, body, department, priority) is the Shaper's
 * job to work out, so nothing here asks for any of it.
 *
 * Submitting posts immediately and never asks again. That is the autonomy
 * contract for typed capture: the operator has already read what they typed.
 */

const SHELL = "inset-x-3 bottom-3 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))] shadow-[var(--shadow-overlay)] motion-safe:data-[state=closed]:animate-sheet-out motion-safe:data-[state=open]:animate-sheet-in sm:left-1/2 sm:top-[18%] sm:bottom-auto sm:w-[min(560px,calc(100vw-32px))] sm:-translate-x-1/2 sm:px-5 sm:py-[18px] sm:motion-safe:data-[state=closed]:animate-pop-out sm:motion-safe:data-[state=open]:animate-pop-in"

function CaptureField({
  text,
  onChange,
  onSubmit,
  locked,
}: {
  text: string
  onChange: (value: string) => void
  onSubmit: () => void
  locked: boolean
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        autoFocus
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          onSubmit()
        }}
        disabled={locked}
        aria-label="Capture"
        data-testid="quick-capture-input"
        placeholder="What's on your mind?"
        className="min-w-0 flex-1 bg-transparent text-[length:var(--text-body)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] disabled:opacity-60"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!text.trim() || locked}
        aria-label="Send capture"
        data-testid="quick-capture-send"
        className="focus-ring inline-flex size-[34px] shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-[var(--accent)] shadow-[var(--inset-shine)] outline-none transition-transform hover:scale-[0.96] disabled:opacity-40 motion-reduce:transition-none"
      >
        <ArrowUp className="size-4" aria-hidden />
      </button>
    </div>
  )
}

export function QuickCaptureBar({ onClose, onTodoCreated }: { onClose: () => void; onTodoCreated?: () => void }) {
  const [text, setText] = useState("")
  const [leaving, setLeaving] = useState(false)
  const { run, start } = useTodoCapture(onTodoCreated)
  const started = run.steps.length > 0

  function submit() {
    const value = text.trim()
    if (!value || started) return
    void start(value, false)
  }

  return (
    <TodoDialog
      open={!leaving}
      label="Quick capture"
      testId="quick-capture"
      onRequestClose={() => setLeaving(true)}
      onClosed={onClose}
      className={SHELL}
    >
      <CaptureField text={text} onChange={setText} onSubmit={submit} locked={started} />

      {started && (
        <div className="mt-3.5 border-t border-[var(--separator)] pt-3.5">
          <PipelineStrip steps={run.steps} state={run.state} error={run.error} settled={run.settled} />
        </div>
      )}
    </TodoDialog>
  )
}
