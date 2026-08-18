/**
 * The orb says what it is doing with motion alone — no text, ever. This module
 * is the whole vocabulary: state in, lobe geometry out. Pure, so the four states
 * can be held apart by a test rather than by eye.
 */

export type OrbVariant = "mist" | "coin" | "ring" | "pulse"

export const ORB_VARIANTS: readonly OrbVariant[] = ["mist", "coin", "ring", "pulse"]

export function isOrbVariant(value: unknown): value is OrbVariant {
  return typeof value === "string" && ORB_VARIANTS.includes(value as OrbVariant)
}

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "interrupted" | "error"

export const ORB_STATES: readonly OrbState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "interrupted",
  "error",
]

export interface OrbParams {
  /** Lobe radius, as a fraction of the sphere radius. */
  radius: number
  /** Edge falloff, as a fraction of the sphere diameter. Past ~0.09 the three lobes merge into a flat disc. */
  softness: number
  /** Brightness multiplier for every lobe. */
  brightness: number
  /** Orbit direction: 1 drifts, -1 counter-rotates. */
  rotationSign: 1 | -1
  /** Lobe centre distance from the sphere centre, as a fraction of the sphere radius. */
  orbit: number
  /** Seconds per orbit, one per lobe. Co-prime-ish so the three never re-align. */
  periods: readonly [number, number, number]
}

/**
 * Each state's resting shape. The four dimensions a viewer reads without a label
 * — size, softness, brightness, direction — are pairwise distinct on purpose.
 */
const BASE: Record<OrbState, OrbParams> = {
  idle: {
    radius: 0.46,
    softness: 0.052,
    brightness: 0.72,
    rotationSign: 1,
    orbit: 0.24,
    periods: [9, 13, 17],
  },
  listening: {
    radius: 0.54,
    softness: 0.068,
    brightness: 0.92,
    rotationSign: 1,
    orbit: 0.34,
    periods: [5, 7, 9],
  },
  thinking: {
    radius: 0.36,
    softness: 0.088,
    brightness: 0.6,
    rotationSign: -1,
    orbit: 0.18,
    periods: [3.2, 4.4, 5.6],
  },
  speaking: {
    radius: 0.64,
    softness: 0.04,
    brightness: 1.1,
    rotationSign: 1,
    orbit: 0.12,
    periods: [2.4, 3.4, 4.4],
  },
  interrupted: {
    radius: 0.31,
    softness: 0.024,
    brightness: 0.48,
    rotationSign: 1,
    orbit: 0.08,
    periods: [11, 14, 19],
  },
  error: {
    radius: 0.42,
    softness: 0.03,
    brightness: 0.5,
    rotationSign: 1,
    orbit: 0.38,
    periods: [0.9, 1.1, 1.3],
  },
}

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
  thinking: { scale: 0.84, alpha: 0.68, flatten: 0.92 },
  speaking: { scale: 1.08, alpha: 1, flatten: 1 },
  interrupted: { scale: 0.78, alpha: 0.72, flatten: 0.72 },
  error: { scale: 0.82, alpha: 0.82, flatten: 0.84 },
}

function sceneEnergy(state: OrbState, level: number): { scale: number; alpha: number; flatten: number } {
  const base = STATE_ENERGY[state]
  const envelope = (state === "listening" || state === "speaking") ? clamp01(level) : 0
  return {
    ...base,
    scale: base.scale + envelope * (state === "speaking" ? 0.12 : 0.08),
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
  const active = state === "listening" || state === "speaking"
  const hole = active ? 0.58 : state === "interrupted" ? 0.72 : 0.66
  return [
    { kind: "ring", x: 0.5 + drift, y: 0.5, rx: 0.37 * energy.scale, ry: 0.25 * energy.scale * energy.flatten, inner: hole, alpha: energy.alpha, tone },
  ]
}

function pulseScene({ state, energy, tone }: SceneInput): readonly OrbPrimitive[] {
  const radii = state === "interrupted" ? [0.14, 0.23, 0.32] : [0.16, 0.27, 0.39]
  const active = state === "listening" || state === "speaking"
  return radii.map((radius, index) => ({
    kind: "ring" as const,
    x: 0.5,
    y: 0.5,
    rx: radius * energy.scale,
    ry: radius * 0.64 * energy.flatten,
    inner: active ? 0.66 : 0.76,
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
export function orbScene(variant: OrbVariant, state: OrbState, level = 0, seconds = 0): readonly OrbPrimitive[] {
  const energy = sceneEnergy(state, level)
  const drift = state === "interrupted" ? 0 : Math.sin(seconds * 0.8) * 0.018
  const tone: OrbTone = state === "error" ? "alert" : "mixed"
  return SCENE_BUILDERS[variant]({ state, energy, drift, tone })
}

/** Relative lobe sizes, so the three read as cloud rather than as one painted
 *  disc. The cool lobe leads: amber wins on a warm base without any help. */
const LOBE_SCALES = [0.88, 1, 0.76] as const

const BASE_ANGLES = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3] as const

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

/**
 * The lobe parameters for a state at a given amplitude. `level` is the 0..1
 * envelope of whatever audio is flowing — input while listening, output while
 * speaking. Idle and thinking have nothing driving them and ignore it.
 */
export function orbParams(state: OrbState, level = 0): OrbParams {
  const base = BASE[state]
  const amplitude = clamp01(level)
  if (state === "listening") {
    return {
      ...base,
      radius: base.radius + 0.12 * amplitude,
      orbit: base.orbit + 0.1 * amplitude,
      brightness: base.brightness + 0.28 * amplitude,
    }
  }
  if (state === "speaking") {
    return {
      ...base,
      radius: base.radius + 0.08 * amplitude,
      brightness: base.brightness + 0.34 * amplitude,
    }
  }
  return base
}

export interface Lobe {
  /** Offset from the sphere centre, in sphere radii. */
  x: number
  y: number
  /** Radius, in sphere radii. */
  radius: number
}

/**
 * Where the three lobes sit at `seconds`. Coordinates are in sphere radii from
 * the centre, so the canvas can scale them to whatever size it is painting at.
 */
export function lobeCentres(params: OrbParams, seconds = 0): Lobe[] {
  return BASE_ANGLES.map((baseAngle, index) => {
    const turns = seconds / params.periods[index]
    const angle = baseAngle + params.rotationSign * 2 * Math.PI * turns
    return {
      x: Math.cos(angle) * params.orbit,
      y: Math.sin(angle) * params.orbit,
      radius: params.radius * LOBE_SCALES[index],
    }
  })
}
