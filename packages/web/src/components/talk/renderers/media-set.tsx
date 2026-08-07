import type { ReactNode } from "react"
import type { AnswerHandler, SituationPayload } from "../situation-payload"
import { SituationCard } from "./situation-card"

type ImagesPayload = Extract<SituationPayload, { kind: "images" }>
type VideoPayload = Extract<SituationPayload, { kind: "video" }>

/**
 * Both media kinds answer the same way — pick the variant you want — so they
 * share one grid and one tile. They stay separate registry entries because the
 * thing inside the tile differs, and because a kind is never a branch.
 *
 * Full-bleed preview on tap is ICI-755's; a tile here answers, it does not zoom.
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

function MediaTile({
  choiceId,
  onAnswer,
  label,
  children,
}: {
  choiceId: string
  onAnswer: AnswerHandler
  label: string
  children: ReactNode
}) {
  return (
    <SituationCard choiceId={choiceId} onAnswer={onAnswer} className="p-[var(--space-2)]">
      <span className="block overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-quaternary)]">
        {children}
      </span>
      <span className="mt-[var(--space-2)] block truncate text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        {label}
      </span>
    </SituationCard>
  )
}

export function ImagesSituation({
  payload,
  onAnswer,
}: {
  payload: ImagesPayload
  onAnswer: AnswerHandler
}) {
  return (
    <MediaGrid kind="images">
      {payload.images.map((image) => (
        <MediaTile
          key={image.id}
          choiceId={image.id}
          onAnswer={onAnswer}
          label={image.caption ?? image.alt}
        >
          <img src={image.src} alt={image.alt} className="block aspect-square w-full object-cover" />
        </MediaTile>
      ))}
    </MediaGrid>
  )
}

export function VideoSituation({
  payload,
  onAnswer,
}: {
  payload: VideoPayload
  onAnswer: AnswerHandler
}) {
  return (
    <MediaGrid kind="video">
      {payload.clips.map((clip) => (
        <MediaTile key={clip.id} choiceId={clip.id} onAnswer={onAnswer} label={clip.label}>
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
