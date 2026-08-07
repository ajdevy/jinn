import type { AnswerHandler, SituationPayload } from "../situation-payload"
import { SituationCard } from "./situation-card"

type OptionsPayload = Extract<SituationPayload, { kind: "options" }>

/** A stack of answers. Tapping one IS the answer — nothing to confirm after. */
export function OptionsSituation({
  payload,
  onAnswer,
}: {
  payload: OptionsPayload
  onAnswer: AnswerHandler
}) {
  return (
    <div
      data-situation-renderer="options"
      className="flex flex-col gap-[var(--space-2)]"
    >
      {payload.options.map((option) => (
        <SituationCard key={option.id} choiceId={option.id} onAnswer={onAnswer}>
          <span className="block font-[var(--weight-medium)]">{option.label}</span>
          {option.detail && (
            <span className="mt-0.5 block text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              {option.detail}
            </span>
          )}
        </SituationCard>
      ))}
    </div>
  )
}

export function optionsSpeech(payload: OptionsPayload): string {
  return payload.options.map((option) => option.label).join(", ")
}
