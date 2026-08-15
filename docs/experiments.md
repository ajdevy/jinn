# Experiments

An experiment is a bet written down before the answer is known. It carries a hypothesis, the baseline it is being measured against, the metrics that would settle it, and a horizon by which it expects to be settled. Readings accumulate against those metrics while it runs, and a verdict closes it.

None of that is optional. An experiment that never declared what "better" would look like cannot be concluded honestly, so the store refuses to create one: at least one metric, a finite baseline value for every metric, and a horizon are all required at the moment of creation rather than filled in later.

There are exactly two states, `running` and `concluded`, and the second is terminal. Most of what follows is a consequence of that one decision.

---

## The data model

An experiment id is `exp_` followed by twelve hex characters. A reading id is `rd_` followed by twelve.

### `Experiment`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `exp_` + 12 hex characters, assigned at creation |
| `name` | string | required, trimmed |
| `hypothesis` | string | required, trimmed: what you expect, and why |
| `status` | `"running" \| "concluded"` | `running` at insert; `concluded` is terminal |
| `startedAt` | string | ISO-8601, stamped at insert |
| `horizonDays` | number | positive safe integer, when you expect an answer |
| `baseline` | `Record<string, number>` | one finite number per declared metric, and no other keys |
| `metrics` | `ExperimentMetric[]` | at least one, names unique |
| `readings` | `ExperimentReading[]` | ordered by `at`, then `id` |
| `verdict` | `ExperimentVerdict` | absent until the experiment is concluded |
| `checkInCronJobId` | string | absent unless a check-in was registered |
| `todoId` | string | absent unless linked to a Todo |
| `owner` | string | absent unless set |

### `ExperimentMetric`

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | required, unique within the experiment |
| `unit` | string | optional |
| `howToMeasure` | string | required: the instruction a check-in reads back |

`howToMeasure` is required because a metric nobody can reproduce is not a metric. It is also the text the scheduled check-in prompt is built from, so writing it vaguely costs something concrete later.

### `ExperimentReading`

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `rd_` + 12 hex characters |
| `experimentId` | string | the experiment it belongs to |
| `at` | string | ISO-8601, normalized by the store |
| `metric` | string | must name a declared metric |
| `value` | number | must be finite |
| `note` | string | optional; an empty or whitespace-only note is dropped rather than stored |

### `ExperimentVerdict`

| Field | Type | Notes |
|-------|------|-------|
| `outcome` | `"win" \| "loss" \| "inconclusive"` | `inconclusive` is a first-class answer, not a failure to answer |
| `note` | string | why the outcome is what it is |
| `concludedAt` | string | ISO-8601, stamped at conclusion |

### Derived on read

Every read returns a `HydratedExperiment`, which is the stored shape plus two fields that are computed per read rather than persisted:

| Field | Type | Meaning |
|-------|------|---------|
| `horizonEndsAt` | string | `startedAt` plus `horizonDays` |
| `overdue` | boolean | `status` is `running` and the horizon has already passed |

They are derived because a stored `overdue` would be a fact that goes stale between writes: nothing happens at the horizon to trigger an update, so the only honest answer is the one computed at the moment you ask.

---

## Lifecycle

```
                 record_reading
                update_experiment
                       |
                    (repeat)
                       |
   create  -->  [ running ]  -->  [ concluded ]
                                    (terminal)
```

| From | Operation | To | Rejected when |
|------|-----------|----|---------------|
| | create | `running` | validation fails, `todoId` names no Todo, or a requested check-in schedule is invalid |
| `running` | record a reading | `running` | the metric is not declared, the value is not finite, or `at` does not parse |
| `running` | update | `running` | no editable field is supplied, or a metric with readings is removed |
| `running` | conclude | `concluded` | the outcome is not one of the three, or the note is missing or too long |
| `concluded` | anything | | always: `conflict` |

A concluded experiment is closed to all three write paths, each with its own refusal: readings are refused with *readings cannot be added after an experiment is concluded*, edits with *concluded experiments cannot be edited*, and a second conclusion with *experiment is already concluded*. Concluding also disables the experiment's check-in cron job, so a closed bet stops asking to be measured.

Nothing reopens a concluded experiment. If the bet is worth running again, it is a new experiment with its own baseline. That is usually the honest framing anyway, since the world has moved since the first one started.

Every failure carries one of three reasons: `invalid` for a rejected input, `not-found` for an unknown id, and `conflict` for an operation the current state does not allow. Over MCP, a `conflict` surfaces as a `409`.

---

## Readings

A reading is an append. There is no edit and no delete: the record of what was measured, when, is the point of keeping it.

Recording one checks, in order, that the experiment exists, that it is still `running`, that `metric` names a metric declared on this experiment, that `value` is a finite number, and that `at` parses as a timestamp. `at` is then re-normalized through `toISOString()`, so readings supplied in different formats still sort against each other correctly. An optional `note` records how the number was arrived at.

Readings are why metrics cannot be freely removed. `update_experiment` will drop a metric that has none, but a metric with recorded readings is refused with `conflict`, because deleting it would delete the measurements taken under it: the schema cascades exactly that way.

The baseline follows the metric set automatically: on update, entries for removed metrics are dropped, and a newly declared metric needs its own baseline value, either supplied in the same call or already stored. A baseline key that names no declared metric is rejected rather than ignored.

---

## What validation enforces

| Field | Rule |
|-------|------|
| `name` | non-empty after trimming, at most 240 characters |
| `hypothesis` | non-empty after trimming, at most 8000 characters |
| metric `name` | non-empty, at most 120 characters, unique within the experiment |
| metric `unit` | when present, non-empty and at most 64 characters |
| `howToMeasure` | non-empty, at most 4000 characters |
| `note` | at most 8000 characters, for both a reading note and a verdict note |
| `owner` | non-empty, at most 120 characters |
| `metrics` | at least one |
| `horizonDays` | positive safe integer, at most 36500 |
| `baseline` | a finite number for every declared metric, and no undeclared keys |
| `todoId` | matches a Todo id shape *and* names a row in `work_items` |
| `outcome` | exactly `win`, `loss`, or `inconclusive` |

`todoId` is checked twice on purpose. The shape check is validation's job; whether that Todo exists is the store's, because only the store holds the ledger to ask. A link naming no Todo would render as a dead link on the detail page and nothing would ever repair it, so the write is refused instead. The ledger lives in the same database file, so the check costs one statement.

`owner` is deliberately free-form rather than a foreign key onto the employee roster. Employees are files that can be renamed or removed, and a stored experiment must not become unwritable when one is.

`todoId` and `owner` are clearable with `null`. Only `update_experiment` offers the null form, because there is nothing to unlink at creation.

`list_experiments` is the one place a bad number is not an error: `limit` is clamped rather than rejected, defaulting to 100 and capping at 500. A list is a view, and a nonsense limit should still return a page.

---

## Check-ins

Creation accepts an optional `checkIn` block of `{ schedule, employee?, timezone? }`. When present, it registers a cron job with the id `experiment-check-in-<id>` whose prompt names the experiment, lists every metric with its unit and `howToMeasure`, tells the reader to append each result with `record_reading`, and states the horizon date.

The horizon is written into the prompt as a date rather than as a computed "overdue" flag: the prompt is written once per edit and read on every fire, so the reader needs something to compare against, not a snapshot of how things stood when it was written.

Ordering matters here. The cron job is written *before* the experiment row, so a rejected schedule cannot leave an orphaned experiment behind; if the insert then fails, the job is removed again. `startedAt` is threaded into the insert so the prompt's horizon date and the stored row agree to the millisecond.

Editing a running experiment rewrites the job's name and prompt from the experiment as it now stands, so a renamed metric or a changed horizon does not leave the check-in reading from a stale copy. Concluding disables the job rather than deleting it, leaving the history visible.

---

## Storage

Three tables, in the same SQLite database as the Todo ledger:

| Table | Key | Holds |
|-------|-----|-------|
| `experiments` | `id` | the row itself, with `baseline_json`, `verdict_outcome`, `verdict_note`, `concluded_at`, `check_in_cron_job_id`, `todo_id`, and `owner` |
| `experiment_metrics` | `(experiment_id, name)` | one row per declared metric, ordered by `ordinal` |
| `experiment_readings` | `id` | one row per reading, with a composite foreign key onto `(experiment_id, metric)` |

`experiment_metrics` is keyed by name rather than by a surrogate id, with `ordinal` carrying the declared order separately. That is what lets an update upsert a metric in place. A renamed metric is a new row and a removed one, which is why a metric with readings cannot be renamed away without hitting the same refusal that blocks removing it.

`status` and `verdict_outcome` are constrained in the schema as well as in the code, so a row written by anything other than the store still cannot hold a fourth status or a fourth outcome.

---

## Tools

Six MCP tools, each proxying the `/api/experiments` routes:

| Tool | Required | Optional |
|------|----------|----------|
| `create_experiment` | `name`, `hypothesis`, `baseline`, `metrics`, `horizonDays` | `todoId`, `owner`, `checkIn` |
| `list_experiments` | | `status`, `limit` |
| `get_experiment` | `id` | |
| `record_reading` | `id`, `at`, `metric`, `value` | `note` |
| `conclude_experiment` | `id`, `outcome`, `note` | |
| `update_experiment` | `id`, and at least one editable field | `name`, `hypothesis`, `metrics`, `baseline`, `horizonDays`, `todoId`, `owner` |

Every tool taking an `id` checks it against `^exp_[0-9a-f]{12}$` before making a request, so a mistyped id fails locally with an explanation instead of arriving at the gateway as a 404.

---

## A worked example

A team suspects their weekly digest email is being ignored, and that a shorter one would be opened more. That is a bet with a number attached, so it gets an experiment.

**Create it**, with a baseline for both metrics and a check-in every Monday morning:

```json
{
  "name": "Short weekly digest",
  "hypothesis": "Cutting the digest to three items raises the open rate without costing subscribers.",
  "metrics": [
    { "name": "open-rate", "unit": "%", "howToMeasure": "Opens divided by delivered, from the mailer's weekly export." },
    { "name": "unsubscribes", "howToMeasure": "Unsubscribes recorded in the seven days after each send." }
  ],
  "baseline": { "open-rate": 21.4, "unsubscribes": 12 },
  "horizonDays": 28,
  "owner": "growth",
  "checkIn": { "schedule": "0 9 * * 1", "timezone": "UTC" }
}
```

`create_experiment` returns the stored experiment with `status: "running"`, a generated `id`, a `checkInCronJobId` of `experiment-check-in-<id>`, and a `horizonEndsAt` 28 days out. The cron job now fires every Monday at 09:00 UTC with a prompt listing both `howToMeasure` instructions and that horizon date.

**Record what the first week measured**, one call per metric:

```json
{ "id": "exp_4c1f9a02b7de", "at": "2026-03-09T09:00:00Z", "metric": "open-rate", "value": 26.8, "note": "First send under the three-item format." }
```

```json
{ "id": "exp_4c1f9a02b7de", "at": "2026-03-09T09:00:00Z", "metric": "unsubscribes", "value": 14 }
```

A third call naming `clicks` would be refused with `invalid`: the metric is not declared, and declaring metrics mid-flight is how a bet quietly becomes unfalsifiable. If `clicks` genuinely belongs in this experiment, `update_experiment` adds it along with its baseline value.

**Conclude it** once the horizon has passed. By then `get_experiment` is returning `overdue: true`, and the check-in prompt has been telling its reader to conclude rather than record yet another reading:

```json
{
  "id": "exp_4c1f9a02b7de",
  "outcome": "win",
  "note": "Open rate held between 26% and 28% across four sends against a 21.4% baseline. Unsubscribes moved from 12 to 14, inside the week-to-week range seen before the change."
}
```

`status` becomes `concluded`, the verdict is stored with its `concludedAt`, and the Monday cron job is disabled. The experiment stays readable forever: the hypothesis, the baseline it was judged against, every reading in order, and the reasoning that closed it.
