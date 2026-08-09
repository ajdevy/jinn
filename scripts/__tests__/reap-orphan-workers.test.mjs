// Ownership of a parentless test worker, which the sweep has to prove rather
// than recognise. Every case here is the same question asked differently: does
// this run hold the authority to kill this PID, and can it show it?
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { planProcessReap } from "../reap/gateways.mjs"

const TEMP = os.tmpdir()
const WORKTREES_ROOT = path.join(TEMP, "reap-orphan-fixture", ".worktrees")
const REMOVED_TREE = path.join(WORKTREES_ROOT, "jinn-build-TEST-1")
const ACTIVE_TREE = path.join(WORKTREES_ROOT, "jinn-build-ACTIVE")

const workerIn = (tree) => `node ${path.join(tree, "node_modules", "vitest", "dist", "worker.js")}`

function context(pruningWorktrees, overrides = {}) {
  return {
    defaultHome: path.join(TEMP, "reap-orphan-fixture", ".jinn"),
    registeredHomes: [],
    homeByPid: {},
    protectedPortPids: [],
    throwawayRoots: [TEMP],
    pruningWorktrees,
    minAgeMinutes: 120,
    selfPids: [],
    ...overrides,
  }
}

const orphan = (pid, args, ageMinutes = 300) => ({ pid, ppid: 1, ageMinutes, rssKiB: 900, args })

function orphanTargets(processes, pruningWorktrees, overrides) {
  const plan = planProcessReap(processes, context(pruningWorktrees, overrides))
  return plan.targets.filter((target) => target.kind === "orphan-test-worker").map((target) => target.pid)
}

// The one the verifier demonstrated: a real parentless worker whose argv sits
// under the worktrees root but inside a tree nobody is deleting.
test("a worker under the worktrees root is spared when its tree is not being removed", () => {
  assert.deepEqual(orphanTargets([orphan(9301, workerIn(ACTIVE_TREE))], [REMOVED_TREE]), [])
})

test("a worker whose path resolves inside a tree this run removes is reaped", () => {
  assert.deepEqual(orphanTargets([orphan(9302, workerIn(REMOVED_TREE))], [REMOVED_TREE]), [9302])
})

test("no worktree is being removed, so no orphan can be owned", () => {
  assert.deepEqual(orphanTargets([orphan(9303, workerIn(REMOVED_TREE))], []), [])
})

test("a sibling tree whose name merely starts with a removed one's is spared", () => {
  const sibling = path.join(WORKTREES_ROOT, "jinn-build-TEST-12")
  assert.deepEqual(orphanTargets([orphan(9304, workerIn(sibling))], [REMOVED_TREE]), [])
})

// A worker launched from inside its own tree names no path at all, so its
// command line cannot settle ownership either way and its working directory is
// the only claim there is.
test("a worker whose cwd is inside a tree this run removes is reaped", () => {
  const relative = { ...orphan(9308, "node ./vitest-worker.js"), cwd: REMOVED_TREE }
  assert.deepEqual(orphanTargets([relative], [REMOVED_TREE]), [9308])
  const nested = { ...relative, cwd: path.join(REMOVED_TREE, "packages", "jinn") }
  assert.deepEqual(orphanTargets([nested], [REMOVED_TREE]), [9308])
})

test("a worker whose cwd is inside a tree nobody is removing is spared", () => {
  const elsewhere = { ...orphan(9309, "node ./vitest-worker.js"), cwd: ACTIVE_TREE }
  assert.deepEqual(orphanTargets([elsewhere], [REMOVED_TREE]), [])
})

test("a worker that is not a test runner is spared even inside a removed tree", () => {
  assert.deepEqual(orphanTargets([orphan(9305, `node ${path.join(REMOVED_TREE, "server.js")}`)], [REMOVED_TREE]), [])
})

test("the age guard and every untouchable reason still outrank a proven tree", () => {
  assert.deepEqual(orphanTargets([orphan(9306, workerIn(REMOVED_TREE), 4)], [REMOVED_TREE]), [])
  const owned = orphan(9307, workerIn(REMOVED_TREE))
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { protectedPortPids: [9307] }), [])
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { selfPids: [9307] }), [])
  assert.deepEqual(orphanTargets([owned], [REMOVED_TREE], { homeByPid: { 9307: path.join(TEMP, "registered") }, registeredHomes: [path.join(TEMP, "registered")] }), [])
})
