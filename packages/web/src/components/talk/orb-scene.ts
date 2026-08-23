/**
 * The orb's paint list: state and amplitude in, primitives out.
 *
 * Split from `orb-motion.ts` so the vocabulary (what the states are, and which
 * audio channel each one rides) stays separate from the material (what a state
 * looks like). The canvas is the only thing that paints; this decides what.
 */
import {
  energyGain,
  isDriven,
  stateEnergy,
  SILENT_ENERGY,
  type OrbEnergy,
  type OrbState,
  type OrbVariant,
} from "./orb-motion"

export type OrbTone = "warm" | "violet" | "mixed" | "alert"

export interface OrbPrimitive {
  kind: "disc" | "ring"
  /** Normalized canvas coordinates. */
  x: number
  y: number
  rx: number
  ry: number
  /** Ring hole as a fraction of the outer radii. */
  inner?: number
  alpha: number
  tone: OrbTone
  /** Fade the perimeter instead of exposing an ellipse edge. */
  fade?: boolean
  /** Use one token fill instead of a lit radial gradient. */
  flat?: boolean
}

const STATE_ENERGY: Record<OrbState, { scale: number; alpha: number; flatten: number }> = {
  idle: { scale: 0.9, alpha: 0.74, flatten: 1 },
  listening: { scale: 1, alpha: 0.94, flatten: 1.04 },
  user_speaking: { scale: 1.04, alpha: 0.97, flatten: 1.1 },
  thinking: { scale: 0.84, alpha: 0.68, flatten: 0.92 },
  assistant_speaking: { scale: 1.08, alpha: 1, flatten: 1 },
  interrupted: { scale: 0.78, alpha: 0.72, flatten: 0.72 },
  error: { scale: 0.82, alpha: 0.82, flatten: 0.84 },
}

function sceneEnergy(state: OrbState, energy: OrbEnergy): { scale: number; alpha: number; flatten: number } {
  const base = STATE_ENERGY[state]
  const envelope = stateEnergy(state, energy)
  return {
    ...base,
    scale: base.scale + envelope * energyGain(state),
    alpha: Math.min(1, base.alpha + envelope * 0.06),
  }
}

interface SceneInput {
  state: OrbState
  energy: ReturnType<typeof sceneEnergy>
  drift: number
  tone: OrbTone
}

function mistScene({ energy, drift, tone }: SceneInput): readonly OrbPrimitive[] {
  return [
    { kind: "disc", x: 0.5 + drift, y: 0.5, rx: 0.39 * energy.scale, ry: 0.24 * energy.scale * energy.flatten, alpha: energy.alpha, tone, fade: true },
  ]
}

function coinScene({ energy, tone }: SceneInput): readonly OrbPrimitive[] {
  return [
    { kind: "disc", x: 0.5, y: 0.5, rx: 0.36 * energy.scale, ry: 0.2 * energy.scale * energy.flatten, alpha: energy.alpha, tone, flat: true },
    { kind: "disc", x: 0.5, y: 0.5, rx: 0.25 * energy.scale, ry: 0.12 * energy.scale * energy.flatten, alpha: energy.alpha * 0.28, tone: "violet", flat: true },
  ]
}

function ringScene({ state, energy, drift, tone }: SceneInput): readonly OrbPrimitive[] {
  const hole = isDriven(state) ? 0.58 : state === "interrupted" ? 0.72 : 0.66
  return [
    { kind: "ring", x: 0.5 + drift, y: 0.5, rx: 0.37 * energy.scale, ry: 0.25 * energy.scale * energy.flatten, inner: hole, alpha: energy.alpha, tone },
  ]
}

function pulseScene({ state, energy, tone }: SceneInput): readonly OrbPrimitive[] {
  const radii = state === "interrupted" ? [0.14, 0.23, 0.32] : [0.16, 0.27, 0.39]
  return radii.map((radius, index) => ({
    kind: "ring" as const,
    x: 0.5,
    y: 0.5,
    rx: radius * energy.scale,
    ry: radius * 0.64 * energy.flatten,
    inner: isDriven(state) ? 0.66 : 0.76,
    alpha: energy.alpha * (index === 1 ? 1 : 0.62),
    tone: state === "error" ? "alert" : index === 2 ? "violet" : tone,
  }))
}

const SCENE_BUILDERS: Record<OrbVariant, (input: SceneInput) => readonly OrbPrimitive[]> = {
  mist: mistScene,
  coin: coinScene,
  ring: ringScene,
  pulse: pulseScene,
}

/** One scene vocabulary hides all four paint strategies from the canvas. */
export function orbScene(
  variant: OrbVariant,
  state: OrbState,
  energy: OrbEnergy = SILENT_ENERGY,
  seconds = 0,
): readonly OrbPrimitive[] {
  const scene = sceneEnergy(state, energy)
  const drift = state === "interrupted" ? 0 : Math.sin(seconds * 0.8) * 0.018
  const tone: OrbTone = state === "error" ? "alert" : "mixed"
  return SCENE_BUILDERS[variant]({ state, energy: scene, drift, tone })
}
