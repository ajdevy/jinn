import { useMemo, useState } from "react"
import { ArrowLeft, CalendarDays, CheckSquare2 } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { Link, useParams } from "react-router-dom"
import { PageLayout } from "@/components/page-layout"
import { LargeTitleHeader } from "@/components/shell/large-title-header"
import { PageScaffold } from "@/components/shell/page-scaffold"
import { EmployeeChip } from "@/components/ui/employee-chip"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api } from "@/lib/api"
import { ConcludeDialog } from "./conclude-dialog"
import { OverduePill } from "./overdue-pill"
import { formatMetricValue, ReadingChart } from "./reading-chart"
import { RecordReadingDialog } from "./record-reading-dialog"
import { useExperiment } from "./use-experiments"
import type { Experiment, ExperimentMetric } from "./types"

type OpenDialog = "reading" | "conclude" | null

function latestFor(experiment: Experiment, metric: ExperimentMetric) {
  return experiment.readings.filter((reading) => reading.metric === metric.name).at(-1)
}

function MetricSection({ experiment, metric }: { experiment: Experiment; metric: ExperimentMetric }) {
  const readings = experiment.readings.filter((reading) => reading.metric === metric.name)
  const latest = latestFor(experiment, metric)
  return (
    <section className="rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-5 shadow-[var(--shadow-card)] md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[length:var(--text-headline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{metric.name}</h2>
          <p className="mt-0.5 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{metric.howToMeasure}</p>
        </div>
        <div className="flex gap-5 text-right">
          <div data-testid={`metric-baseline-${metric.name}`}>
            <div className="text-[length:var(--text-caption2)] uppercase tracking-[0.1em] text-[var(--text-quaternary)]">Baseline</div>
            <div className="mt-0.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] tabular-nums text-[var(--text-secondary)]">
              {formatMetricValue(experiment.baseline[metric.name], metric.unit)}
            </div>
          </div>
          <div data-testid={`metric-latest-${metric.name}`}>
            <div className="text-[length:var(--text-caption2)] uppercase tracking-[0.1em] text-[var(--text-quaternary)]">Latest</div>
            <div className="mt-0.5 text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] tabular-nums text-[var(--text-primary)]">
              {formatMetricValue(latest?.value, metric.unit)}
            </div>
          </div>
        </div>
      </div>
      {readings.length < 2 ? (
        <div className="mt-4 rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] px-4 py-10 text-center text-[length:var(--text-footnote)] text-[var(--text-tertiary)]" data-testid={`metric-readings-empty-${metric.name}`}>
          {readings.length === 0 ? "No readings yet" : "One reading recorded · add another to draw the trend"}
        </div>
      ) : (
        <ReadingChart metric={metric} readings={readings} baseline={experiment.baseline[metric.name]} />
      )}
    </section>
  )
}

function verdictLabel(outcome: NonNullable<Experiment["verdict"]>["outcome"]): string {
  return outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : "Inconclusive"
}

function ActionButton({ label, onClick, testId }: { label: string; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="focus-ring min-h-9 rounded-full bg-[var(--fill-tertiary)] px-3.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
    >
      {label}
    </button>
  )
}

/** The Todo this experiment informs and the person watching it. Both are
 *  optional, so each renders only when set and the row disappears with them. */
function ExperimentLinks({ experiment }: { experiment: Experiment }) {
  const org = useQuery({ queryKey: ["org"], queryFn: api.getOrg, staleTime: 60_000 })
  // The owner is stored as free text, so the registry may not know the name.
  // Showing it as typed beats showing nothing.
  const ownerDisplayName = useMemo(
    () => org.data?.employees.find((employee) => employee.name === experiment.owner)?.displayName,
    [org.data, experiment.owner],
  )
  if (!experiment.todoId && !experiment.owner) return null
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
      {experiment.todoId && (
        <Link
          to={`/todos/${experiment.todoId}`}
          data-testid="experiment-todo-link"
          className="focus-ring inline-flex min-h-[34px] items-center gap-1.5 rounded-full bg-[var(--fill-tertiary)] px-3 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]"
        >
          <CheckSquare2 className="size-3.5" aria-hidden />
          {experiment.todoId}
        </Link>
      )}
      {experiment.owner && (
        <EmployeeChip
          employee={experiment.owner}
          displayName={ownerDisplayName ?? experiment.owner}
          className="min-h-[34px]"
        />
      )}
    </div>
  )
}

export default function ExperimentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const query = useExperiment(id)
  const experiment = query.data?.experiment
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null)
  useBreadcrumbs([{ label: "Experiments", href: "/experiments" }, { label: experiment?.name ?? "Experiment" }])

  return (
    <PageLayout>
      <PageScaffold
        header={
          experiment ? (
            <LargeTitleHeader
              leading={
                <Link to="/experiments" className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]">
                  <ArrowLeft className="size-4" aria-hidden />
                  Experiments
                </Link>
              }
              title={experiment.name}
              subtitle={
                <>
                  <div className="flex items-center gap-2 text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                    <span className="size-2 rounded-full" style={{ background: experiment.status === "running" ? "var(--system-blue)" : "var(--system-green)" }} aria-hidden />
                    {experiment.status === "running" ? "Running" : "Concluded"}
                    {experiment.overdue && <OverduePill id={experiment.id} />}
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[length:var(--text-footnote)] text-[var(--text-quaternary)]">
                    <CalendarDays className="size-3.5" aria-hidden />
                    Started {new Date(experiment.startedAt).toLocaleDateString()} · {experiment.horizonDays}-day horizon
                  </div>
                  <ExperimentLinks experiment={experiment} />
                </>
              }
              trailing={
                experiment.status === "running" ? (
                  <div className="flex shrink-0 gap-2">
                    <ActionButton label="Record reading" testId="experiment-record-reading-open" onClick={() => setOpenDialog("reading")} />
                    <ActionButton label="Conclude" testId="experiment-conclude-open" onClick={() => setOpenDialog("conclude")} />
                  </div>
                ) : null
              }
            />
          ) : (
            <LargeTitleHeader
              leading={
                <Link to="/experiments" className="inline-flex min-h-[34px] items-center gap-1.5 rounded-full px-2 text-[length:var(--text-footnote)] font-[var(--weight-medium)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]">
                  <ArrowLeft className="size-4" aria-hidden />
                  Experiments
                </Link>
              }
              title="Experiment"
            />
          )
        }
      >
        <main className="mx-auto max-w-[900px]">
          {query.isPending ? (
            <div className="py-20 text-center text-[var(--text-tertiary)]">Loading experiment…</div>
          ) : query.isError || !experiment ? (
            <div className="mt-5 rounded-[var(--radius-lg)] bg-[var(--fill-tertiary)] p-4 text-[var(--system-red)]">
              {query.error instanceof Error ? query.error.message : "Experiment not found."}
            </div>
          ) : (
            <>

              <section className="mt-7">
                <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--text-secondary)]">Hypothesis</div>
                <p className="mt-2 max-w-[760px] text-[length:var(--text-title3)] leading-relaxed text-[var(--text-primary)]">{experiment.hypothesis}</p>
              </section>

              {experiment.readings.length === 0 && (
                <div className="mt-7 rounded-[var(--radius-xl)] bg-[var(--accent-fill)] px-5 py-4 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]" data-testid="experiment-detail-readings-empty">
                  No readings yet. Scheduled or manual check-ins will build the series here.
                </div>
              )}

              <div className="mt-7 space-y-4">
                {experiment.metrics.map((metric) => <MetricSection key={metric.name} experiment={experiment} metric={metric} />)}
              </div>

              {experiment.verdict && (
                <section className="mt-7 rounded-[var(--radius-xl)] bg-[var(--bg-secondary)] px-5 py-5 shadow-[var(--shadow-card)] md:px-6">
                  <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[0.12em] text-[var(--accent)]">
                    Verdict · {verdictLabel(experiment.verdict.outcome)}
                  </div>
                  <p className="mt-2 text-[length:var(--text-body)] leading-relaxed text-[var(--text-primary)]">{experiment.verdict.note}</p>
                  <div className="mt-2 text-[length:var(--text-caption1)] text-[var(--text-quaternary)]">
                    Concluded {new Date(experiment.verdict.concludedAt).toLocaleDateString()}
                  </div>
                </section>
              )}

              {openDialog === "reading" && (
                <RecordReadingDialog
                  experimentId={experiment.id}
                  metrics={experiment.metrics}
                  onClose={() => setOpenDialog(null)}
                />
              )}
              {openDialog === "conclude" && (
                <ConcludeDialog experimentId={experiment.id} onClose={() => setOpenDialog(null)} />
              )}
            </>
          )}
        </main>
      </PageScaffold>
    </PageLayout>
  )
}
