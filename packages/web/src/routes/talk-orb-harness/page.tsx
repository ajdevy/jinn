import { useEffect, useRef, useState } from "react"
import { ORB_STATES, type OrbState } from "@/components/talk/orb-motion"
import type { SituationPayload } from "@/components/talk/situation-payload"
import { presentSituation } from "@/components/talk/talk-situation-store"
import { TalkSurface } from "@/components/talk/talk-surface"
import { cn } from "@/lib/utils"
import { SITUATION_KINDS, situationFixture } from "./situation-fixtures"
import { ToolBench } from "./tool-bench"

/**
 * DEV-only bench for the Talk orb: every state on demand, a synthetic amplitude
 * standing in for the audio nothing produces yet, and enough page to scroll
 * behind the sphere.
 */

/** A pair of beating sines reads as speech; one sine reads as a metronome. */
function useSyntheticLevel(state: OrbState) {
  const level = useRef(0)
  useEffect(() => {
    if (state !== "listening" && state !== "speaking") {
      level.current = 0
      return
    }
    let frame = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const seconds = now / 1000
      level.current = Math.abs(Math.sin(seconds * 2.3) * 0.6 + Math.sin(seconds * 5.7) * 0.4)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [state])
  return level
}

function StatePicker({ state, onPick }: { state: OrbState; onPick: (next: OrbState) => void }) {
  return (
    <div className="flex flex-wrap gap-[var(--space-2)]">
      {ORB_STATES.map((option) => (
        <button
          key={option}
          onClick={() => onPick(option)}
          aria-pressed={option === state}
          className={cn(
            "h-[38px] cursor-pointer rounded-full border-none px-4 text-[length:var(--text-subheadline)] capitalize",
            option === state
              ? "bg-[var(--accent-fill)] text-[var(--accent)]"
              : "bg-[var(--fill-tertiary)] text-[var(--text-secondary)]",
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

/** Raises one situation per payload kind, which is the reproducible QA path. */
function SituationPicker({ onPick }: { onPick: (kind: SituationPayload["kind"]) => void }) {
  return (
    <div className="mt-[var(--space-3)] flex flex-wrap gap-[var(--space-2)]">
      {SITUATION_KINDS.map((kind) => (
        <button
          key={kind}
          onClick={() => onPick(kind)}
          className={cn(
            "h-[38px] cursor-pointer rounded-full border-none px-4 capitalize",
            "bg-[var(--fill-tertiary)] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]",
          )}
        >
          {kind}
        </button>
      ))}
    </div>
  )
}

/** Something for the orb to keep animating in front of. */
function ScrollBed() {
  return (
    <div className="mt-[var(--space-5)] flex flex-col gap-[var(--space-3)]">
      {Array.from({ length: 40 }, (_, row) => (
        <div
          key={row}
          className="h-[72px] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)]"
        />
      ))}
    </div>
  )
}

export default function TalkOrbHarnessPage() {
  const [state, setState] = useState<OrbState>("idle")
  const levelRef = useSyntheticLevel(state)

  return (
    <div className="h-dvh overflow-y-auto bg-[var(--bg)] px-[var(--space-5)] py-[var(--space-6)]">
      <StatePicker state={state} onPick={setState} />
      <SituationPicker onPick={(kind) => presentSituation(situationFixture(kind))} />
      <div className="mt-[var(--space-5)]">
        <ToolBench />
      </div>
      <ScrollBed />
      <TalkSurface state={state} levelRef={levelRef} />
    </div>
  )
}
