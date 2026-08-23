import { Check, CircleAlert, LoaderCircle } from "lucide-react"
import type { TodoCaptureWire } from "@/lib/api"
import { CAPTURE_STEPS, stepLabel, type CaptureStep } from "./capture-stages"

/**
 * The live pipeline, one line per fact.
 *
 * Only steps the wire has actually reported are rendered — `steps` is the
 * accumulated truth, never the full ladder greyed out ahead of itself. Showing
 * the remaining stages dimmed would be a promise the system has not made, and
 * the whole point of deriving the stage server-side is not to make it.
 *
 * Motion is transform and opacity only, one short move per line as it lands.
 */

export function PipelineStrip({
  steps,
  state,
  error,
  settled,
}: {
  steps: CaptureStep[]
  state: TodoCaptureWire | null
  error: string | null
  settled: boolean
}) {
  const lastIndex = steps.length - 1

  return (
    <ol className="flex flex-col gap-1.5" data-testid="capture-pipeline">
      {steps.map((step, index) => {
        const isLast = index === lastIndex
        const running = isLast && !settled && !error
        return (
          <li
            key={step}
            data-testid={`capture-step-${step}`}
            data-current={isLast || undefined}
            className="flex items-center gap-2.5 text-[length:var(--text-subheadline)] motion-safe:animate-capture-step-in"
            style={{ color: isLast ? "var(--text-primary)" : "var(--text-tertiary)" }}
          >
            <StepMark running={running} />
            <span className="min-w-0 truncate">{stepLabel(step, state)}</span>
          </li>
        )
      })}

      {error && (
        <li
          data-testid="capture-error"
          className="flex items-start gap-2.5 text-[length:var(--text-subheadline)] motion-safe:animate-capture-step-in"
          style={{ color: "var(--system-red)" }}
        >
          <CircleAlert className="mt-[3px] size-[15px] shrink-0" aria-hidden />
          {/* The gateway's own words. Never softened, never replaced. */}
          <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
        </li>
      )}
    </ol>
  )
}

function StepMark({ running }: { running: boolean }) {
  if (running) {
    return <LoaderCircle className="size-[15px] shrink-0 motion-safe:animate-spin" style={{ color: "var(--accent)" }} aria-hidden />
  }
  return <Check className="size-[15px] shrink-0" style={{ color: "var(--accent)" }} aria-hidden />
}

/** Exported for the test that pins the ladder's order to the server's. */
export const PIPELINE_STEP_ORDER = CAPTURE_STEPS
