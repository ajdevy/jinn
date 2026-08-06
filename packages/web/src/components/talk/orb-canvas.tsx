import { useEffect, useRef, useState, type RefObject } from "react"
import { lobeCentres, orbParams, type Lobe, type OrbParams, type OrbState } from "./orb-motion"

/**
 * Three blurred lobes drifting inside a sphere with no outline. A 2D canvas
 * rather than a CSS filter stack: `blur()` on a 64px element re-rasterizes on
 * every scroll frame, and the orb has to hold its animation while the page
 * behind it scrolls.
 */

const PALETTE_TOKENS = [
  "--orb-core",
  "--orb-base",
  "--orb-bloom",
  "--orb-lobe-a",
  "--orb-lobe-b",
  "--orb-lobe-c",
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
  params: OrbParams
  seconds: number
}

/**
 * Body under the lobes, so the page never shows through the gaps. Concentric —
 * an offset centre would read as a specular highlight, which turns the light
 * body into a glass marble.
 */
function paintBase(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const centre = frame.size / 2
  const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre)
  gradient.addColorStop(0, frame.palette["--orb-core"])
  gradient.addColorStop(0.55, frame.palette["--orb-bloom"])
  gradient.addColorStop(1, frame.palette["--orb-base"])
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, frame.size, frame.size)
}

/**
 * Dissolves the rim instead of cutting it. A clip path would give the sphere the
 * hard outline the whole design is trying not to have; masking on alpha lets the
 * body fade into the page. Only the alpha channel of this gradient is used, so
 * the colour in it is not a colour decision.
 */
function maskRim(ctx: CanvasRenderingContext2D, size: number): void {
  const centre = size / 2
  const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, centre)
  gradient.addColorStop(0, "rgba(0,0,0,1)")
  gradient.addColorStop(0.55, "rgba(0,0,0,1)")
  gradient.addColorStop(0.82, "rgba(0,0,0,0.5)")
  gradient.addColorStop(1, "rgba(0,0,0,0)")
  ctx.globalCompositeOperation = "destination-in"
  ctx.globalAlpha = 1
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size, size)
}

function paintLobe(ctx: CanvasRenderingContext2D, frame: Frame, lobe: Lobe, color: string): void {
  const centre = frame.size / 2
  const x = centre + lobe.x * centre
  const y = centre + lobe.y * centre
  const radius = lobe.radius * centre + frame.params.softness * frame.size
  // Each lobe keeps its own hue all the way out. A shared mid-stop here made
  // every lobe the same colour and the sphere lost its amber-to-violet read.
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, color)
  gradient.addColorStop(1, "transparent")
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.fill()
}

function paintOrb(ctx: CanvasRenderingContext2D, frame: Frame): void {
  ctx.globalCompositeOperation = "source-over"
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, frame.size, frame.size)
  paintBase(ctx, frame)
  ctx.globalCompositeOperation = "lighter"
  ctx.globalAlpha = Math.min(1, frame.params.brightness)
  const colors = [frame.palette["--orb-lobe-a"], frame.palette["--orb-lobe-b"], frame.palette["--orb-lobe-c"]]
  lobeCentres(frame.params, frame.seconds).forEach((lobe, index) => {
    paintLobe(ctx, frame, lobe, colors[index])
  })
  maskRim(ctx, frame.size)
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/** Live `prefers-reduced-motion` flag. Read on the first render, not in an effect,
 *  so the animation loop never starts for a frame before being cancelled. */
function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia?.(REDUCED_MOTION).matches === true)
  useEffect(() => {
    const mq = window.matchMedia?.(REDUCED_MOTION)
    if (!mq) return
    const on = () => setReduce(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return reduce
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
  /** Live 0..1 amplitude, read once per frame. React state here would re-render
   *  the whole app on every audio frame. */
  levelRef: RefObject<number>
  /** CSS size in px. The sphere fills the square. */
  size: number
}

export function OrbCanvas({ state, levelRef, size }: OrbCanvasProps) {
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
    if (reduce) {
      paintOrb(ctx, { size, palette, params: orbParams(state), seconds: 0 })
      return
    }

    let frame = 0
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      paintOrb(ctx, { size, palette, params: orbParams(state, levelRef.current), seconds: now / 1000 })
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
    // `themeAttribute` is not read here — it re-reads the palette when the theme flips.
  }, [state, size, reduce, themeAttribute, levelRef])

  return <canvas ref={canvasRef} aria-hidden style={{ width: size, height: size, display: "block" }} />
}
