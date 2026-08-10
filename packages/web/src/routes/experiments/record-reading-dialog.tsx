import { useState } from "react"
import { DialogField, ExperimentDialog, OptionPills } from "./experiment-dialog"
import { useRecordReading } from "./use-experiments"
import type { ExperimentMetric } from "./types"

interface ReadingDraft {
  metric: string
  value: string
  note: string
}

function ReadingFields({
  metrics,
  draft,
  onChange,
}: {
  metrics: ExperimentMetric[]
  draft: ReadingDraft
  onChange: (patch: Partial<ReadingDraft>) => void
}) {
  return (
    <>
      <DialogField label="Metric">
        <OptionPills
          label="Metric"
          options={metrics.map((declared) => ({
            value: declared.name,
            label: declared.unit ? `${declared.name} (${declared.unit})` : declared.name,
          }))}
          selected={draft.metric}
          onSelect={(metric) => onChange({ metric })}
        />
      </DialogField>
      <DialogField label="Value">
        <input
          autoFocus
          type="number"
          step="any"
          inputMode="decimal"
          aria-label="Value"
          data-testid="experiment-reading-value"
          value={draft.value}
          onChange={(event) => onChange({ value: event.target.value })}
          placeholder="0"
          className="apple-input min-h-11 w-full tabular-nums"
        />
      </DialogField>
      <DialogField label="Note (optional)">
        <textarea
          aria-label="Note"
          data-testid="experiment-reading-note"
          value={draft.note}
          onChange={(event) => onChange({ note: event.target.value })}
          placeholder="What changed since the last reading?"
          rows={2}
          className="apple-input min-h-[64px] w-full resize-y py-2"
        />
      </DialogField>
    </>
  )
}

/** Appends one point to a series. The metric comes from the declared list rather
 *  than a text field — a free-typed name could only ever produce a 400 — and the
 *  timestamp is now, because this dialog exists to record a measurement as it is
 *  taken. Backfilling an older date is what `record_reading` is for. */
export function RecordReadingDialog({
  experimentId,
  metrics,
  onClose,
}: {
  experimentId: string
  metrics: ExperimentMetric[]
  onClose: () => void
}) {
  const [draft, setDraft] = useState<ReadingDraft>({ metric: metrics[0]?.name ?? "", value: "", note: "" })
  const mutation = useRecordReading(experimentId)
  const value = Number(draft.value)
  const canSubmit = !!draft.metric && draft.value.trim() !== "" && Number.isFinite(value)

  return (
    <ExperimentDialog
      title="Record reading"
      submitLabel="Record"
      submittingLabel="Recording…"
      submitting={mutation.isPending}
      canSubmit={canSubmit}
      error={mutation.error instanceof Error ? mutation.error.message : null}
      testId="experiment-record-reading"
      onClose={onClose}
      onSubmit={() => mutation.mutate(
        {
          at: new Date().toISOString(),
          metric: draft.metric,
          value,
          ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        },
        { onSuccess: onClose },
      )}
    >
      <ReadingFields metrics={metrics} draft={draft} onChange={(patch) => setDraft({ ...draft, ...patch })} />
    </ExperimentDialog>
  )
}
