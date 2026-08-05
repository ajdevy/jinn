# PLA-63 — `workflow-call` node: dynamic fan-out and join

Branch `build/PLA-63-workflow-call-fanout` off `main` @ `d280bcf69ae61a8d34ef92b25c5386b975a151fa`.

## What exists today (read, not assumed)

- `workflow-call` exists **only as a trigger kind** (`model.ts:164`). Nothing in the graph can call a
  workflow; the only caller path is `WorkflowService.callWorkflow` (`service.ts:265`), reached from an
  Employee node's session through the MCP/HTTP attempt surface.
- `validateCaller` (`service.ts:166`) requires the caller node to be **type `employee`** with an active
  attempt, and walks the caller ancestry rejecting a target that appears in it. That ancestry walk is the
  real recursion guard.
- Child runs already record their parent: `trigger.payload.caller = { workflowId, runId, nodeId }`, written
  at `service.ts:283`. There is **no query** to go the other way (parent → children).
- `end.config.output` is authored and validated (`model.ts:254`, `validation.ts:180`) but **never resolved**:
  `applyInline`'s end branch (`runner.ts:352`) completes the node with no output. So today a run produces no
  output of its own. Requirement 2 ("each child's end output fields") is unimplementable without closing
  this — so closing it is part of this change, not an adjacent problem.
- `WorkflowNodeTypeV2` in the web is derived from the wire union, and `TINT` / `TYPE_ICON` /
  `NODE_TYPE_LABEL` are `Record<WorkflowNodeTypeV2, …>`. Adding a node type **fails typecheck** until the
  editor is updated, so editor support is compulsory, not optional polish.

### One noted discrepancy with the Todo

The Todo says cycles are "rejected at save time". They are not — `validateExecutableWorkflow` has no
repository access and cannot follow a call chain across workflows, and the target is a binding that may
only be known at runtime. The existing guard is the **runtime ancestry check** in `validateCaller`, which
this change reuses and extends to the new node type. The one case that *is* statically decidable — a
`fixed` target equal to the defining workflow's own id — gets a save-time validation issue as well.

## Design

**No database migration.** Parent→child lookup is a `json_extract(trigger_json,'$.caller.runId')` query,
the same technique `readWorkflowCallByIdempotency` (`repository-runs.ts:210`) already uses. The linkage is
already durable in `trigger_json`; adding `parent_run_id` columns would mean a v4 migration, new
`CREATE_DOMAIN_SCHEMA_V4` string surgery, integrity-SQL edits and migration-test churn, to store a fact the
row already carries. Cost of the chosen path is a table scan per reconcile; that is far cheaper than
`assertHistoryIntegrity`, which already runs full-table JSON work on every run-list call.

**Child state is derived, never mirrored.** The parent node keeps no bookkeeping of in-flight children. On
every reconcile it reads the child runs by caller and decides from them. This is crash-safe by construction
and removes the dual-write class of bug entirely. Per-item ordering rides in the child's trigger payload as
`itemIndex`, which also makes `{{ trigger.itemIndex }}` available inside the child.

**Waking the parent.** `WorkflowService` already funnels every run change through one `onChange` hook
(`service.ts:127`). A child run reaching a terminal status there wakes its caller. `recover()` gains the
crash fallback: any recoverable run with an activated non-terminal `workflow-call` node gets advanced.

**Serialised advance.** A synchronously-completing child can re-enter `advance()` on the parent while the
parent is mid-advance, which would collide on `mutateRun`'s expected revision and fail a healthy run. The
runner gets a per-run advance queue (chain + coalesce) used by the caller-wake path.

**Termination.** `advance()`'s loop budget is `nodes.length * 4 + 4`; a fan-out that starts items across
successive reconciles can exceed it when children settle synchronously. Items are bounded at 100 per node
(same order as the existing node/edge caps) and the budget gains that bound per `workflow-call` node.

## Files

| File | Change |
| --- | --- |
| `workflows/model.ts` | `workflowCallNodeSchema` (strictObject): `workflowId` (string binding), `items?` (binding), `input?` (record of bindings), `concurrency` (int ≥1 ≤16, default 2). Add to `rawWorkflowNodeSchema`; export `WorkflowCallNode`. |
| `workflows/validation.ts` | `portsOf` → `['success']`; binding checks for `workflowId` / `items` / each `input` value; save-time issue when a `fixed` `workflowId` equals the defining workflow's id. |
| `workflows/runner.ts` | `NodeAction` kind `fanout`; `nextAction` returns it only when there is an item to start or every child is terminal; `reconcileFanout` (start up to the concurrency slack, else join); join output; per-run advance queue + `advanceCaller`; resolve `end.config.output` into the End node's output. |
| `workflows/service.ts` | Wire `callWorkflow` into the runner; `validateCaller` accepts an activated `workflow-call` node (and in the ancestry walk); `onChange` wakes the caller of a terminal child; `cancelRun` cancels non-terminal children; `recover()` advances stalled fan-out parents. |
| `workflows/repository-runs.ts` / `repository.ts` | `readRunsByCaller(runId, nodeId)` → child summaries `{ runId, workflowId, itemIndex, status, endedAt, endOutput, error }`; expose as `listChildRuns`. |
| `workflows/runtime.ts` | `nodeType` union gains `workflow-call`; child-summary type. |
| `workflows/repository-runs.ts` (decode) | `nodeRecordSchema.nodeType` + `CHILD_INTEGRITY` node-type list gain `workflow-call`. |
| `gateway/workflow-api.ts` | Run detail (lean + full) carries `childRuns` so the canvas has live child status without the fat payload. |
| `web/src/lib/api.ts` | Wire types for the node and `childRuns`. |
| `web/…/editor/{node-icons,ports,inspector,palette,add-menu}.tsx` | Icon/tint/label, `['success']` port, a config form (target, items, input map, concurrency), palette entry. |
| `web/…/run-canvas.tsx`, `node-card.tsx` | Fan-out badge: `succeeded/total` + a status glyph. |
| `web/…/run-inspector.tsx` | Child-run list, each linking to its run page. |

Tokens only, both themes, 390px included — `jinn-design` bar applies to the badge and the child list.

## Acceptance criteria

1. A definition with a `workflow-call` node saves, validates, and round-trips through the editor without
   losing or mutating the node's config (Zod strictObject, revision snapshot).
2. With `items` bound to an array of N and `concurrency` = C, at most C child runs are non-terminal at any
   moment, and all N eventually start, each carrying its `itemIndex` and mapped `input`.
3. With `items` absent, exactly one child run starts.
4. Every child run records its caller (`trigger.payload.caller.runId` = the parent run id), and
   `listChildRuns(parentRunId, nodeId)` returns them in `itemIndex` order.
5. When every child is terminal, the node completes with output fields `total`, `succeeded`, `failed`,
   `cancelled`, `summary` (`all-succeeded` | `partial` | `none-succeeded`) and `outcomes[]`, each entry
   carrying `index`, `runId`, `workflowId`, `status` and the child's End-node output fields.
6. A child that fails does **not** fail the node or abort its siblings: remaining items still start, the
   node completes, and a downstream Condition on `node.<id>.fields.summary` routes on the result.
7. Cancelling the parent run cancels every non-terminal child run (each child's status becomes `cancelled`).
8. A `workflow-call` node targeting a workflow already in its own caller ancestry fails that node with the
   existing recursion error; a `fixed` target equal to the defining workflow's own id is refused at save
   time with a validation issue.
9. A run whose End node declares `config.output` completes that node with the resolved value as its output
   fields; a non-object resolution fails the node with a message naming the problem (regression test: the
   value was silently dropped before this change).
10. The parent resumes correctly after a restart: with a fan-out mid-flight and children settled while the
    process was down, `recover()` advances the parent to completion without a duplicate child run.
11. Concurrent wakes on one parent run do not produce a revision conflict: a synchronously-completing child
    and an in-flight parent advance both land (test drives the child to complete inside the parent's
    reconcile).
12. Run canvas: a `workflow-call` node card shows `succeeded/total` and a live status; selecting it lists
    the child runs in the inspector, each linking to its own run page. Verified by screenshot at
    1440×900 and 390×844, light and dark, on a sandbox gateway (`jinn-sandbox.sh up qa-pla63`, never 7777
    or 7788), destroyed afterwards.
13. `pnpm typecheck`, `pnpm lint`, `pnpm test` pass from the worktree; no existing workflow test regresses.
14. The repository privacy leak check is clean on the staged diff for this change.

## Tests

- `workflows/__tests__/workflow-fanout.test.ts` (new): criteria 2, 3, 5, 6, 7, 8, 11 against the in-memory
  repository + fake executor, following `workflow-control-flow.test.ts` and `workflow-vertical.test.ts`.
- `workflows/__tests__/workflow-recovery.test.ts`: criterion 10.
- `workflows/__tests__/model.test.ts`, `validation.test.ts`: criteria 1, 8 (schema + save-time issue).
- `workflows/__tests__/repository-runs.test.ts`: criterion 4.
- A dedicated End-output test for criterion 9, written **red first** (assert it fails on `main`'s
  behaviour before the fix).
- `web/…/__tests__/run-canvas.test.tsx`: badge and child list rendering.
- Manual: sandbox gateway screenshots for criterion 12.

## Out of scope

Nested-canvas rendering of a child run inside the parent (the Todo defers it). Loops or cycles inside one
definition. Retry policies for children beyond what the child workflow defines. Any change to the
`todo-status` trigger or its actor guard. A `parent_run_id` schema migration. An `error` output port on the
fan-out node — a failed child is reported through `summary`, per requirement 4. Fixing pre-existing
findings elsewhere in the tree; those become follow-up Todos.
