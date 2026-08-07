import type { MouseEvent as ReactMouseEvent, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { openPreview, type OriginRect, type PreviewItem } from "../media-preview-store"
import type { SituationPayload } from "../situation-payload"
import { SITUATION_SURFACE } from "./situation-card"

type ImagesPayload = Extract<SituationPayload, { kind: "images" }>
type VideoPayload = Extract<SituationPayload, { kind: "video" }>

/**
 * Both media kinds open the same way — full size, at the one you tapped — so
 * they share one grid and one tile. They stay separate registry entries because
 * the thing inside the tile differs, and because a kind is never a branch.
 *
 * A tile does not answer: it raises the preview, and the preview carries the
 * answer. Something worth looking at properly is worth looking at before it is
 * picked, and one tap cannot mean both.
 */

/** Fits three variants side by side on a desktop sheet, two on a phone. */
function MediaGrid({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <div
      data-situation-renderer={kind}
      className="grid grid-cols-[repeat(auto-fit,minmax(128px,1fr))] gap-[var(--space-2)]"
    >
      {children}
    </div>
  )
}

function boxOf(element: Element): OriginRect {
  const bounds = element.getBoundingClientRect()
  return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
}

/** The whole set opens, so the preview can be stepped across without closing. */
function MediaTile({
  items,
  index,
  children,
}: {
  items: PreviewItem[]
  index: number
  children: ReactNode
}) {
  const item = items[index]
  const open = (event: ReactMouseEvent<HTMLButtonElement>) => {
    openPreview(items, index, boxOf(event.currentTarget))
  }

  return (
    // A native button, so Enter and Space open the preview for free.
    <button
      type="button"
      data-situation-tile={item.id}
      onClick={open}
      className={cn(SITUATION_SURFACE, "p-[var(--space-2)]")}
    >
      <span className="block overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-quaternary)]">
        {children}
      </span>
      <span className="mt-[var(--space-2)] block truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        {item.label}
      </span>
    </button>
  )
}

function imageItems(payload: ImagesPayload): PreviewItem[] {
  return payload.images.map((image) => ({
    id: image.id,
    kind: "image",
    src: image.src,
    label: image.caption ?? image.alt,
  }))
}

function clipItems(payload: VideoPayload): PreviewItem[] {
  return payload.clips.map((clip) => ({
    id: clip.id,
    kind: "video",
    src: clip.src,
    poster: clip.poster,
    label: clip.label,
  }))
}

export function ImagesSituation({ payload }: { payload: ImagesPayload }) {
  const items = imageItems(payload)
  return (
    <MediaGrid kind="images">
      {payload.images.map((image, index) => (
        <MediaTile key={image.id} items={items} index={index}>
          <img src={image.src} alt={image.alt} className="block aspect-square w-full object-cover" />
        </MediaTile>
      ))}
    </MediaGrid>
  )
}

export function VideoSituation({ payload }: { payload: VideoPayload }) {
  const items = clipItems(payload)
  return (
    <MediaGrid kind="video">
      {payload.clips.map((clip, index) => (
        <MediaTile key={clip.id} items={items} index={index}>
          {/* Metadata only: the tile is a still of the first frame, not a player. */}
          <video
            src={clip.src}
            poster={clip.poster}
            preload="metadata"
            muted
            playsInline
            aria-label={clip.label}
            className="block aspect-square w-full object-cover"
          />
        </MediaTile>
      ))}
    </MediaGrid>
  )
}

export function imagesSpeech(payload: ImagesPayload): string {
  return payload.images.map((image) => image.caption ?? image.alt).join(", ")
}

export function videoSpeech(payload: VideoPayload): string {
  return payload.clips.map((clip) => clip.label).join(", ")
}
