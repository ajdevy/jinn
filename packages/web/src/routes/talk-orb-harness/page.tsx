import { useEffect, useRef, useState } from "react"
import { OrbCanvas } from "@/components/talk/orb-canvas"
import { OrbVariantPicker } from "@/components/talk/orb-variant-picker"
import { ORB_STATES, ORB_VARIANTS, SILENT_ENERGY, stateEnergy, type OrbEnergy, type OrbState } from "@/components/talk/orb-motion"
import type { SituationPayload } from "@/components/talk/situation-payload"
import {
  presentSituation,
  restoreDeferredSituation,
  useDeferredSituation,
} from "@/components/talk/talk-situation-store"
import { TalkSurface } from "@/components/talk/talk-surface"
import { usePrefersReducedMotion } from "@/components/talk/use-reduced-motion"
import { cn } from "@/lib/utils"
import { useSettings } from "@/routes/settings-provider"
import { SITUATION_KINDS, situationFixture } from "./situation-fixtures"
import { ToolBench } from "./tool-bench"

/**
 * DEV-only bench for the Talk orb: every state on demand, a synthetic amplitude
 * standing in for the audio nothing produces yet, and enough page to scroll
 * behind the sphere.
 */

/**
 * A pair of beating sines reads as speech; one sine reads as a metronome.
 *
 * Both channels are driven, and the state picks the one it rides — which is the
 * point of the bench: a state wired to the wrong channel shows up here as an
 * orb that will not move.
 */
function useSyntheticEnergy(state: OrbState) {
  const energy = useRef<OrbEnergy>({ input: 0, output: 0 })
  const reduce = usePrefersReducedMotion()
  useEffect(() => {
    const silent = () => { energy.current.input = 0; energy.current.output = 0 }
    if (reduce || stateEnergy(state, { input: 1, output: 1 }) === 0) {
      silent()
      return
    }
    let frame = 0
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const seconds = now / 1000
      const value = Math.abs(Math.sin(seconds * 2.3) * 0.6 + Math.sin(seconds * 5.7) * 0.4)
      energy.current.input = value
      energy.current.output = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reduce, state])
  return energy
}

const QUIET_ENERGY = { current: SILENT_ENERGY }

function VariantGallery() {
  return (
    <div className="grid grid-cols-1 gap-[var(--space-3)] xl:grid-cols-2">
      {ORB_VARIANTS.map((variant) => (
        <section
          key={variant}
          className="rounded-[var(--radius-xl)] bg-[var(--fill-quaternary)] p-[var(--space-4)] shadow-[var(--shadow-subtle)]"
        >
          <h2
            data-orb-variant-heading={variant}
            className="mb-[var(--space-3)] text-[length:var(--text-headline)] font-medium capitalize text-[var(--text-primary)]"
          >
            {variant}
          </h2>
          <div className="grid grid-cols-3 gap-[var(--space-2)] sm:grid-cols-6">
            {ORB_STATES.map((state) => (
              <div
                key={state}
                data-orb-preview
                data-orb-variant={variant}
                data-orb-state={state}
                className="min-w-0 rounded-[var(--radius-md)] bg-[var(--material-ultra-thin)] px-[var(--space-1)] py-[var(--space-2)] text-center"
              >
                <div className="flex justify-center">
                  <OrbCanvas variant={variant} state={state} energyRef={QUIET_ENERGY} size={56} motion="still" />
                </div>
                <span className="block truncate text-[length:var(--text-caption2)] capitalize text-[var(--text-secondary)]">
                  {state}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
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
            "min-h-10 cursor-pointer rounded-full border-none px-4 text-[length:var(--text-subheadline)] capitalize transition-transform duration-150 ease-out active:scale-[0.96]",
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

const BENCH_BUTTON = cn(
  "min-h-10 cursor-pointer rounded-full border-none px-4",
  "text-[length:var(--text-subheadline)]",
)

/**
 * Raises one situation per payload kind, which is the reproducible QA path — and
 * offers the last dismissed one back, which is how a deferral is shown to be a
 * deferral rather than a deletion.
 */
function SituationPicker({ onPick }: { onPick: (kind: SituationPayload["kind"]) => void }) {
  const deferred = useDeferredSituation()
  return (
    <div className="mt-[var(--space-3)] flex flex-wrap gap-[var(--space-2)]">
      {SITUATION_KINDS.map((kind) => (
        <button
          key={kind}
          onClick={() => onPick(kind)}
          className={cn(
            BENCH_BUTTON,
            "capitalize bg-[var(--fill-tertiary)] text-[var(--text-secondary)]",
          )}
        >
          {kind}
        </button>
      ))}
      <button
        onClick={restoreDeferredSituation}
        disabled={!deferred}
        className={cn(
          BENCH_BUTTON,
          "bg-[var(--accent-fill)] text-[var(--accent)]",
          "disabled:cursor-default disabled:bg-[var(--fill-quaternary)] disabled:text-[var(--text-quaternary)]",
        )}
      >
        Raise last dismissed
      </button>
    </div>
  )
}

export default function TalkOrbHarnessPage() {
  const [state, setState] = useState<OrbState>("idle")
  const energyRef = useSyntheticEnergy(state)
  const { settings, setTalkOrbVariant } = useSettings()

  return (
    <div className="h-dvh overflow-y-auto bg-[var(--bg)] px-[var(--space-4)] py-[var(--space-6)] sm:px-[var(--space-6)]">
      <main className="mx-auto max-w-[1000px] pb-28">
        <h1 className="text-balance text-[length:var(--text-title2)] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
          Talk orb
        </h1>
        <p className="mb-[var(--space-5)] mt-[var(--space-2)] max-w-[58ch] text-pretty text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
          Choose a calm shape, then compare how every voice state reads. Your choice follows the floating control across reloads.
        </p>

        <OrbVariantPicker
          value={settings.talkOrbVariant}
          onChange={setTalkOrbVariant}
          state={state}
          className="mb-[var(--space-4)]"
        />
        <StatePicker state={state} onPick={setState} />

        <div className="mt-[var(--space-5)]">
          <VariantGallery />
        </div>

        <details className="mt-[var(--space-5)] rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] p-[var(--space-4)] text-[var(--text-secondary)]">
          <summary className="min-h-10 cursor-pointer text-[length:var(--text-footnote)]">Developer controls</summary>
          <SituationPicker onPick={(kind) => presentSituation(situationFixture(kind))} />
          <div className="mt-[var(--space-5)]"><ToolBench /></div>
        </details>
      </main>
      <TalkSurface variant={settings.talkOrbVariant} state={state} energyRef={energyRef} />
    </div>
  )
}
