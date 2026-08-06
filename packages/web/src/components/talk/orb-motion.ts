/**
 * The orb says what it is doing with motion alone — no text, ever. This module
 * is the whole vocabulary: state in, lobe geometry out. Pure, so the four states
 * can be held apart by a test rather than by eye.
 */

export type OrbState = "idle" | "listening" | "thinking" | "speaking"

export const ORB_STATES: readonly OrbState[] = ["idle", "listening", "thinking", "speaking"]

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
