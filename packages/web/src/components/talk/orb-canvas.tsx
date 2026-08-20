import { useEffect, useRef, useState, type RefObject } from "react"
import {
  orbScene,
  type OrbPrimitive,
  type OrbState,
  type OrbTone,
  type OrbVariant,
} from "./orb-motion"
import { usePrefersReducedMotion } from "./use-reduced-motion"

/**
 * Four flat geometries painted from one pure scene model. A 2D canvas rather
 * than a CSS filter stack keeps the 64px control cheap while the page scrolls.
 */

const PALETTE_TOKENS = [
  "--orb-core",
  "--orb-base",
  "--orb-bloom",
  "--orb-lobe-a",
  "--orb-lobe-b",
  "--orb-lobe-c",
  "--system-red",
] as const

type OrbPalette = Record<(typeof PALETTE_TOKENS)[number], string>

/** Custom properties inherit, so the sphere's own computed style carries the theme. */
function readPalette(element: Element): OrbPalette {
  const style = getComputedStyle(element)
  const palette = {} as OrbPalette
  for (const token of PALETTE_TOKENS) palette[token] = style.getPropertyValue(token).trim()
  return palette
}

interface Frame {
  /** CSS size of the square the sphere fills. */
  size: number
  palette: OrbPalette
  variant: OrbVariant
  state: OrbState
  level: number
  seconds: number
}

function toneColors(palette: OrbPalette, tone: OrbTone): readonly [string, string, string] {
  if (tone === "warm") return [palette["--orb-core"], palette["--orb-lobe-a"], palette["--orb-base"]]
  if (tone === "violet") return [palette["--orb-bloom"], palette["--orb-lobe-b"], palette["--orb-lobe-c"]]
  if (tone === "alert") return [palette["--orb-core"], palette["--system-red"], palette["--orb-base"]]
  return [palette["--orb-core"], palette["--orb-bloom"], palette["--orb-lobe-c"]]
}

function paintPrimitive(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  primitive: OrbPrimitive,
): void {
  const x = primitive.x * frame.size
  const y = primitive.y * frame.size
  const rx = primitive.rx * frame.size
  const ry = primitive.ry * frame.size
  const colors = toneColors(frame.palette, primitive.tone)
  if (primitive.flat) ctx.fillStyle = colors[1]
  else {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry))
    gradient.addColorStop(0, colors[0])
    gradient.addColorStop(0.58, colors[1])
    gradient.addColorStop(1, primitive.fade ? "transparent" : colors[2])
    ctx.fillStyle = gradient
  }
  ctx.globalAlpha = primitive.alpha
  ctx.beginPath()
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
  if (primitive.kind === "ring") {
    const inner = primitive.inner ?? 0.66
    ctx.ellipse(x, y, rx * inner, ry * inner, 0, 0, Math.PI * 2, true)
    ctx.fill("evenodd")
  } else ctx.fill()
}

function paintOrb(ctx: CanvasRenderingContext2D, frame: Frame): void {
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, frame.size, frame.size)
  for (const primitive of orbScene(frame.variant, frame.state, frame.level, frame.seconds)) {
    paintPrimitive(ctx, frame, primitive)
  }
  ctx.globalAlpha = 1
}

/**
 * The palette hangs off `data-theme` on the root, and that attribute is the one
 * thing every theme path touches. Picking a theme writes it; so does an OS
 * scheme flip while the setting sits on "system" — and that second path changes
 * no React state at all, so a repaint keyed on the theme *setting* never fires
 * and the sphere keeps the palette it was born with.
 */
function useThemeAttribute(): string {
  const [attribute, setAttribute] = useState(() => document.documentElement.dataset.theme ?? "")
  useEffect(() => {
    const root = document.documentElement
    const read = () => setAttribute(root.dataset.theme ?? "")
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] })
    read()
    return () => observer.disconnect()
  }, [])
  return attribute
}

interface OrbCanvasProps {
  state: OrbState
  variant?: OrbVariant
  /** Live 0..1 amplitude, read once per frame. React state here would re-render
   *  the whole app on every audio frame. */
  levelRef: RefObject<number>
  /** CSS size in px. The sphere fills the square. */
  size: number
  /** Comparison surfaces paint one deterministic frame even when motion is allowed. */
  motion?: "live" | "still"
}

export function OrbCanvas({ state, variant = "mist", levelRef, size, motion = "live" }: OrbCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduce = usePrefersReducedMotion()
  const themeAttribute = useThemeAttribute()

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const palette = readPalette(canvas)

    // Still, not dead: one frame per state, in that state's own geometry.
    if (reduce || motion === "still") {
      paintOrb(ctx, { size, palette, variant, state, level: 0, seconds: 0 })
      return
    }

    let frame = 0
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      paintOrb(ctx, { size, palette, variant, state, level: levelRef.current, seconds: now / 1000 })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
    // `themeAttribute` is not read here — it re-reads the palette when the theme flips.
  }, [state, variant, size, reduce, motion, themeAttribute, levelRef])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-orb-canvas-variant={variant}
      style={{ width: size, height: size, display: "block" }}
    />
  )
}
