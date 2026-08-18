import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { test } from "node:test"

import {
  FIXTURE_CLOCK,
  TALK_SESSION_ID,
  assertDisposableHome,
  fixtureTopics,
  mergeById,
  prepareSandbox,
} from "../talk-driving-fixture.mjs"

const disposable = path.join(os.tmpdir(), ".jinn-talk-driving-fixture")

test("declares twelve durable topics with stable unique identities", () => {
  const topics = fixtureTopics({
    todoIds: {
      blocked: "PLA-1",
      blocker: "PLA-2",
      delegated: "PLA-3",
      approval: "PLA-4",
    },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  })

  assert.equal(topics.length, 12)
  assert.equal(new Set(topics.map(({ id }) => id)).size, 12)
  assert.deepEqual(topics.map(({ ordinal }) => ordinal), Array.from({ length: 12 }, (_, index) => index + 1))
  assert.equal(topics[0].state, "active")
  assert.ok(topics.slice(1, 4).every(({ state }) => state === "warm"))
  assert.ok(topics.slice(4).every(({ state }) => state === "cool"))
  assert.ok(topics.every(({ talkSessionId }) => talkSessionId === TALK_SESSION_ID))
  assert.ok(topics.every(({ goal, decisions, unresolvedQuestions, retrievalAnchors }) =>
    goal.length > 0 && decisions.length > 0 && unresolvedQuestions.length > 0 && retrievalAnchors.length > 0))
})

test("uses a fixed fixture clock so cold-reload ordering is reproducible", () => {
  assert.equal(FIXTURE_CLOCK, Date.parse("2026-08-18T09:00:00.000Z"))
  assert.deepEqual(fixtureTopics({
    todoIds: { blocked: "PLA-1", blocker: "PLA-2", delegated: "PLA-3", approval: "PLA-4" },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  }), fixtureTopics({
    todoIds: { blocked: "PLA-1", blocker: "PLA-2", delegated: "PLA-3", approval: "PLA-4" },
    workflowId: "sandbox-approval-flow",
    workflowRunId: "run_fixture",
  }))
})

test("refuses the installed home and protected gateway ports", () => {
  assert.throws(
    () => assertDisposableHome(path.join(os.homedir(), ".jinn"), { gateway: { port: 7999 } }),
    /production instance home/,
  )
  for (const port of [7777, 7788]) {
    assert.throws(() => assertDisposableHome(disposable, { gateway: { port } }), /protected gateway/)
  }
  assert.doesNotThrow(() => assertDisposableHome(disposable, { gateway: { port: 7799 } }))
})

test("merges owned fixture records by id without deleting unrelated records", () => {
  assert.deepEqual(
    mergeById(
      [{ id: "unrelated", value: 1 }, { id: "owned", value: 1 }],
      [{ id: "owned", value: 2 }, { id: "new", value: 3 }],
    ),
    [{ id: "unrelated", value: 1 }, { id: "owned", value: 2 }, { id: "new", value: 3 }],
  )
})

test("seeding the same stopped home twice reuses every durable identity", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-talk-driving-seed-"))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, "config.yaml"), "gateway:\n  port: 7799\nengines:\n  default: codex\n  claude: {}\n  codex:\n    model: gpt-5.5\nportal:\n  companyName: Sandbox Company\n  companyPrefix: SBX\n")

  const first = await prepareSandbox(home)
  const second = await prepareSandbox(home)
  assert.deepEqual(second, first)

  const requireFromJinn = createRequire(new URL("../../packages/jinn/package.json", import.meta.url))
  const Database = requireFromJinn("better-sqlite3")
  const sessions = new Database(path.join(home, "sessions", "registry.db"), { readonly: true })
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM work_items").pluck().get(), 4)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM work_item_approvals WHERE state = 'pending'").pluck().get(), 1)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM talk_topics").pluck().get(), 12)
  assert.equal(sessions.prepare("SELECT COUNT(*) FROM talk_proactive_receipts").pluck().get(), 2)
  assert.equal(sessions.prepare("SELECT high_water FROM work_item_id_allocator WHERE prefix = 'PLA'").pluck().get(), 4)
  sessions.close()

  const workflows = new Database(path.join(home, "workflows", "workflows.db"), { readonly: true })
  assert.equal(workflows.prepare("SELECT COUNT(*) FROM workflow_runs").pluck().get(), 1)
  assert.equal(workflows.prepare("SELECT COUNT(*) FROM workflow_approvals WHERE status = 'pending'").pluck().get(), 1)
  workflows.close()
})
