import { useSyncExternalStore } from "react"

/**
 * The media set currently open at full size, held outside React for the same
 * reason the situation is: a renderer deep inside the sheet raises the preview,
 * and there is no prop path from there to the surface that draws it.
 */

export interface PreviewItem {
  id: string
  kind: "image" | "video"
  src: string
  /** The still a clip shows before it plays. */
  poster?: string
  /** What the caption reads, and what a screen reader hears. */
  label: string
}

/** The thumbnail's box in viewport coordinates: where the preview grows from. */
export interface OriginRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PreviewSet {
  /** The whole set, so A/B/C can be compared without closing and reopening. */
  items: PreviewItem[]
  index: number
  origin: OriginRect | null
}

let open: PreviewSet | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Open the whole set at the item that was tapped. */
export function openPreview(items: PreviewItem[], index: number, origin: OriginRect | null): void {
  if (items.length === 0) return
  open = { items, index, origin }
  emit()
}

export function closePreview(): void {
  if (!open) return
  open = null
  emit()
}

/** Step across the set, wrapping, without ever taking the preview down. */
export function stepPreview(direction: -1 | 1): void {
  if (!open) return
  const count = open.items.length
  open = { ...open, index: (open.index + direction + count) % count }
  emit()
}

export function usePreview(): PreviewSet | null {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => null,
  )
}
