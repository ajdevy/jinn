import type { SituationPayload } from "../situation-payload"

type ProsePayload = Extract<SituationPayload, { kind: "prose" }>

/** Something to read and answer out loud. The only kind with nothing to tap. */
export function ProseSituation({ payload }: { payload: ProsePayload }) {
  return (
    <p
      data-situation-renderer="prose"
      className="text-pretty text-[length:var(--text-subheadline)] leading-[var(--leading-relaxed)] text-[var(--text-primary)]"
    >
      {payload.text}
    </p>
  )
}

export function proseSpeech(payload: ProsePayload): string {
  return payload.text
}
