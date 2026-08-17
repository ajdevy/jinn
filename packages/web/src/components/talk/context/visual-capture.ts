import { sanitizedClone, TALK_PRIVATE_SELECTORS } from "./dom-semantics"
import type { TalkScreenContext } from "./page-snapshot"

export const VISUAL_CAPTURE_MAX_WIDTH = 1_280
export const VISUAL_CAPTURE_MAX_HEIGHT = 1_280
/** Leaves room for base64 and the surrounding provider event below common
 *  WebRTC data-channel message limits. */
export const VISUAL_CAPTURE_MAX_BYTES = 180_000

export interface VisualRenderOptions {
  exclude: readonly string[]
  maxWidth: number
  maxHeight: number
  maxBytes: number
}

export interface RenderedVisual {
  dataUrl: string
  width: number
  height: number
  bytes: number
}

export type VisualRenderer = (root: HTMLElement, options: VisualRenderOptions) => Promise<RenderedVisual>

export interface VisualCaptureReceipt {
  requestKey: string
  contextRevision: number
  reason: string
  bytes: number
  width: number
  height: number
  estimatedImageTokens: number
  latencyMs: number
}

export type VisualCaptureResult =
  | {
      ok: true
      event: {
        type: "conversation.item.create"
        item: { type: "message"; role: "user"; content: Array<{ type: "input_image"; image_url: string }> }
      }
      receipt: VisualCaptureReceipt
    }
  | { ok: false; code: string; error: string }

export interface VisualCaptureRequest {
  context: TalkScreenContext
  reason: string
  /** Final provider user item/event identity for the question asking to see. */
  requestKey: string
  root: HTMLElement
}

function estimatedImageTokens(width: number, height: number): number {
  return 85 + Math.ceil(width / 512) * Math.ceil(height / 512) * 170
}

function stylesText(): string {
  const rules: string[] = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) rules.push(rule.cssText)
    } catch {
      // Cross-origin styles are not readable. The renderer remains useful with
      // local app styles, and a failed raster is reported instead of guessed.
    }
  }
  return rules.join("\n")
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("The sanitized page could not be rasterized."))
    image.src = source
  })
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The browser could not encode the visual fallback.")), "image/webp", quality)
  })
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("The visual fallback could not be read."))
    reader.readAsDataURL(blob)
  })
}

/** Browser-native DOM rasterization; no display-capture permission is opened. */
export const renderDomVisual: VisualRenderer = async (root, options) => {
  const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1)
  const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight || 1)
  const scale = Math.min(1, options.maxWidth / viewportWidth, options.maxHeight / viewportHeight)
  const width = Math.max(1, Math.round(viewportWidth * scale))
  const height = Math.max(1, Math.round(viewportHeight * scale))
  root.style.width = `${viewportWidth}px`
  root.style.height = `${viewportHeight}px`
  root.setAttribute("xmlns", "http://www.w3.org/1999/xhtml")
  const markup = new XMLSerializer().serializeToString(root)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewportWidth} ${viewportHeight}"><style>${stylesText()}</style><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }))
  try {
    const image = await loadImage(url)
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) throw new Error("The browser has no canvas renderer for visual fallback.")
    context.drawImage(image, 0, 0, width, height)
    let blob: Blob | null = null
    for (const quality of [0.82, 0.68, 0.52, 0.38]) {
      blob = await canvasBlob(canvas, quality)
      if (blob.size <= options.maxBytes) break
    }
    if (!blob || blob.size > options.maxBytes) throw new Error("The visual fallback exceeded its byte budget.")
    return { dataUrl: await blobDataUrl(blob), width, height, bytes: blob.size }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function preflightProblem(request: VisualCaptureRequest): VisualCaptureResult | null {
  if (request.context.freshness === "complete") {
    return { ok: false, code: "structured-context-sufficient", error: "Structured screen context already answers this question." }
  }
  if (!request.context.visualGaps.includes(request.reason)) {
    return { ok: false, code: "visual-gap-not-declared", error: `The current page did not declare the visual gap "${request.reason}".` }
  }
  return null
}

function renderedOutOfBounds(rendered: RenderedVisual): boolean {
  return rendered.width < 1 || rendered.height < 1
    || rendered.width > VISUAL_CAPTURE_MAX_WIDTH
    || rendered.height > VISUAL_CAPTURE_MAX_HEIGHT
    || rendered.bytes > VISUAL_CAPTURE_MAX_BYTES
    || !rendered.dataUrl.startsWith("data:image/")
}

async function captureOne(
  render: VisualRenderer,
  now: () => number,
  reserved: Set<string>,
  request: VisualCaptureRequest,
): Promise<VisualCaptureResult> {
  const problem = preflightProblem(request)
  if (problem) return problem
  const key = `${request.context.browserInstanceId}:${request.requestKey}:${request.context.revision}:${request.reason}`
  if (reserved.has(key)) {
    return { ok: false, code: "visual-fallback-already-used", error: "This question already used its one visual fallback." }
  }
  reserved.add(key)
  const startedAt = now()
  try {
    const rendered = await render(sanitizedClone(request.root), {
      exclude: TALK_PRIVATE_SELECTORS,
      maxWidth: VISUAL_CAPTURE_MAX_WIDTH,
      maxHeight: VISUAL_CAPTURE_MAX_HEIGHT,
      maxBytes: VISUAL_CAPTURE_MAX_BYTES,
    })
    if (renderedOutOfBounds(rendered)) {
      return { ok: false, code: "visual-fallback-out-of-bounds", error: "The rendered visual fallback exceeded its declared bounds." }
    }
    const receipt: VisualCaptureReceipt = {
      requestKey: request.requestKey,
      contextRevision: request.context.revision,
      reason: request.reason,
      bytes: rendered.bytes,
      width: rendered.width,
      height: rendered.height,
      estimatedImageTokens: estimatedImageTokens(rendered.width, rendered.height),
      latencyMs: Math.max(0, now() - startedAt),
    }
    return {
      ok: true,
      event: {
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_image", image_url: rendered.dataUrl }] },
      },
      receipt,
    }
  } catch (error) {
    return { ok: false, code: "visual-fallback-failed", error: error instanceof Error ? error.message : String(error) }
  }
}

export function createVisualCapture(dependencies: { render?: VisualRenderer; now?: () => number } = {}) {
  const render = dependencies.render ?? renderDomVisual
  const now = dependencies.now ?? (() => performance.now())
  const reserved = new Set<string>()
  // `reserved` is scoped to the live driver and written before await inside
  // captureOne, so concurrent calls for one utterance still admit one raster.
  return { request: (request: VisualCaptureRequest) => captureOne(render, now, reserved, request) }
}
