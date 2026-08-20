import { useState } from "react"
import { OptionPills } from "@/components/ui/option-pills"
import { DialogField, ExperimentDialog } from "./experiment-dialog"
import { useConcludeExperiment } from "./use-experiments"
import type { ExperimentVerdict } from "./types"

const OUTCOMES: { value: ExperimentVerdict["outcome"]; label: string }[] = [
  { value: "win", label: "Win" },
  { value: "loss", label: "Loss" },
  { value: "inconclusive", label: "Inconclusive" },
]

/** Ends the experiment. The note is required here even though the gateway would
 *  accept an empty one: a verdict nobody explained is a verdict nobody can use. */
export function ConcludeDialog({ experimentId, onClose }: { experimentId: string; onClose: () => void }) {
  const [outcome, setOutcome] = useState<ExperimentVerdict["outcome"]>("win")
  const [note, setNote] = useState("")
  const mutation = useConcludeExperiment(experimentId)

  return (
    <ExperimentDialog
      title="Conclude experiment"
      submitLabel="Conclude"
      submittingLabel="Concluding…"
      submitting={mutation.isPending}
      canSubmit={note.trim() !== ""}
      error={mutation.error instanceof Error ? mutation.error.message : null}
      testId="experiment-conclude"
      onClose={onClose}
      onSubmit={() => mutation.mutate({ outcome, note: note.trim() }, { onSuccess: onClose })}
    >
      <DialogField label="Outcome">
        <OptionPills
          label="Outcome"
          options={OUTCOMES}
          selected={outcome}
          onSelect={(value) => setOutcome(value as ExperimentVerdict["outcome"])}
        />
      </DialogField>
      <DialogField label="What the readings showed">
        <textarea
          autoFocus
          aria-label="Verdict note"
          data-testid="experiment-conclude-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What happened, and what it means for the decision."
          rows={4}
          className="apple-input min-h-[104px] w-full resize-y py-2"
        />
      </DialogField>
    </ExperimentDialog>
  )
}
