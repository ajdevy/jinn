# PLA-65 — Propagate `todoId` to called runs; allow dual triggers

Branch `build/PLA-65-call-todoid-dual-triggers` off `main` @ `8be3128c`.

## What is broken today

`WorkflowService.callWorkflow()` (`packages/jinn/src/workflows/service.ts:289`) stamps
`trigger: { kind: "workflow-call", payload: { caller, itemIndex } }` and never sets
`trigger.todoId`. Every Todo-binding surface reads `run.trigger.todoId`:
`bindingContext` → `{{ run.todoId }}` (`runner.ts:141`), approval mirroring
(`runner.ts:543`), reflection / failure / gate-decision echo (`runner.ts:566/581/595/857`),
session attribution (`runner.ts:632`), and Todo completion (`runner.ts:681`). A fan-out over
child Todos therefore produces children blind to their own Todo.

Separately, `addReachabilityIssues` (`validation.ts:308`) hard-requires
`triggers.length === 1`, so a definition cannot carry both a `todo-status` and a
`workflow-call` trigger.

Two things already work and need no change — verified by reading, not assumed:

- `WorkflowTriggerService` selects triggers by kind (`trigger-service.ts:29`), so a second
  trigger node of another kind does not disturb arming.
- `WorkflowRunner.start()` activates `run.trigger.nodeId` specifically (`runner.ts:396`),
  `nextAction` skips all trigger nodes, and `activationPossible` returns `false` for a
  non-activated trigger (no incoming edges), so the trigger that did not fire is already
  treated as unreachable by `canNeverActivate`/`mergeReady`, and `finish()` only waits on
  *activated* nodes. A dual-trigger run settles.

## Changes

**1. `service.ts` — `WorkflowCallInput.todoId?: string`.**
Validate with `TODO_ID_PATTERN` (`packages/jinn/src/work-items/id.ts`) and `fail("bad-input", …)`
in the same style as the existing caller/idempotency guards. Stamp it onto the created run's
trigger exactly as `startManual` does:
`trigger: { …, ...(todoId ? { todoId } : {}) }`. Pass it into the replay lookup too.

**2. `repository.ts` — `findWorkflowCallByIdempotency` must compare the same trigger it will
later store.** It reconstructs an expected trigger and canonical-JSON-compares it
(`repository.ts:339`). Without threading `todoId` through, a legitimate replay of a call that
carried a `todoId` would raise `idempotency-conflict`. Add an optional `todoId` to its input
and include it in the reconstructed trigger. `createRun`'s own replay check already compares
`value.trigger` verbatim, so it stays consistent.

**3. `runner.ts` — lift `todoId` out of the per-item input mapping.** In `reconcileFanout`
(`runner.ts:518`), after `fanoutInput(...)`, if the authored `node.config.input` declares a
`todoId` key, its resolved value must be a Todo-shaped string; pass it as `callWorkflow({ todoId })`.
The field **stays in the child run's `input`** as well — removing it would silently change
`{{ input.todoId }}` for existing definitions and destabilise nothing in return.
An authored `todoId` that resolves to a non-string or a non-`AAA-123` string fails the
workflow-call node with an honest error rather than being dropped (a mapped-but-ignored
`todoId` is exactly the silent blindness this ticket exists to remove).

**4. `validation.ts` — trigger rules.** Replace the `triggers.length !== 1` rule with:

- `trigger-count` — "Workflow must contain at least one Trigger." when there are none;
- `duplicate-trigger-kind` — at most one trigger per kind, reported on the duplicate node.
  This is not speculative: `trigger-service.ts` and `startManual` both select a trigger with
  `.find(kind)`, so a second trigger of the same kind would be silently unarmable. Today that
  is impossible; relaxing the count is what makes it reachable, so the guard ships with it.

Existing `unreachable-node` / `dead-node` rules already force every trigger to sit on a path
to an End, so no extra reachability rule is needed.

**5. Prose the diff falsifies.** `packages/web/src/routes/workflow/editor/add-menu.tsx:5`
says "a workflow has exactly one Trigger". Reword to describe the placement rule only
(triggers are placed from the palette, not mid-graph). No behaviour change to the editor.

**6. Tests that assert the old message** — `workflows/__tests__/validation.test.ts:246` and
`workflows/__tests__/service-validation.test.ts:116,154` — updated to the new wording/rule.

## Acceptance criteria

1. `callWorkflow({ todoId: "PLA-9", … })` creates a run whose `trigger.todoId === "PLA-9"`;
   `callWorkflow` with a malformed `todoId` (`"pla-9"`, `"PLA-0"`, `"NOTATODO"`, non-string)
   throws `bad-input` and creates no run.
2. In a called run carrying a lifted `todoId`, an employee prompt containing `{{ run.todoId }}`
   interpolates to that Todo id.
3. In the same run, a parked approval calls `todoApprovals.request` with that `todoId`, and the
   PLA-64 paths (`todoLifecycle.reflect`, gate-decision echo, `recordFailure`) receive it too.
4. Idempotency: a second `callWorkflow` with the same `workflowId` + `input` + `caller` +
   `itemIndex` + `idempotencyKey` + `todoId` returns the *same* run id. The same key replayed
   with a different `todoId` raises `idempotency-conflict`.
5. A workflow-call node whose `input` mapping produces `todoId` lifts it onto the child run's
   trigger and keeps it in the child's `input`. With no `todoId` in the mapping, the child run
   has no `trigger.todoId` and the call still succeeds. With a mapped `todoId` resolving to a
   non-Todo-shaped value, the workflow-call node fails with an error naming the node and the
   expected `AAA-123` shape.
6. `validateExecutableWorkflow` returns `ok` for a definition carrying both a `todo-status`
   trigger and a `workflow-call` trigger (each wired to an End); still reports `trigger-count`
   for zero triggers; reports `duplicate-trigger-kind` for two triggers of the same kind.
7. That dual-trigger definition arms via `WorkflowTriggerService` (a matching Todo status event
   starts a run that reaches `completed`) and is accepted by `callWorkflow`.
8. `pnpm --filter jinn typecheck`, `pnpm --filter jinn lint`, and `pnpm --filter jinn test` pass
   from a clean run after the final edit; the staged diff passes the privacy leak-grep.

## Tests

Extend, do not create new suites:

- `packages/jinn/src/workflows/__tests__/workflow-fanout.test.ts` — criteria 1, 4, 5.
- `packages/jinn/src/workflows/__tests__/todo-reflection.test.ts` (fake `todoLifecycle`/
  `todoApprovals` already live there) — criteria 2, 3.
- `packages/jinn/src/workflows/__tests__/validation.test.ts` — criterion 6.
- `packages/jinn/src/workflows/__tests__/workflow-triggers.test.ts` — criterion 7.

No manual/browser check is required: nothing user-visible changes except one code comment.

## Out of scope

- Fan-out concurrency/join semantics, the actor guard, the trigger-service replay log
  (explicitly excluded by the Todo).
- Any new trigger field beyond `todoId`.
- Web editor support for *authoring* a second trigger (the palette still offers one); only the
  comment that the model change falsifies is corrected.
- Editing the `jinn-build` definition itself — it lives in the instance database, not the repo.
- Adding `todoId` shape validation to `startManual`, which does not have it today.
