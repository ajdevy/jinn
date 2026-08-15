// `node --test` applies no per-test timeout by default, so a subprocess or browser that never
// answers does not fail — it hangs until the outer harness cancels the whole file, which is how a
// stall of several minutes once took an unrelated run down with it. Nothing in these tests asserts
// on timing; these ceilings only decide how long a machine starved by parallel test runs is allowed
// to take before a hang is called a hang. The slowest of them, observed under four concurrent
// vitest runs, took 21.6 s. The wait ceiling sits under the test ceiling so a stuck subprocess or
// browser fails with its own named error rather than as an anonymous test timeout.
export const EXTERNAL_WAIT_CEILING_MS = 90_000

/** node:test options for a test that launches a browser or a subprocess. */
export const external = { timeout: 120_000 }

// A few guards assert on the REAL process table, through `ps eww -axo pid=,command=`, because that
// is how the lab decides which processes are its own before it reaps anything. That output is the
// host's, not ours: which processes expose their environment, and to whom, differs between macOS
// and Linux. The lab only ever runs on the operator's machine, so these two guards were written
// against macOS and had never executed in CI until `guards.test.mjs` joined `test:node` — where
// they promptly failed on a process table that reports differently, then hung the runner for
// 38 minutes and cost a release its 45-minute job budget.
//
// Skipping them off-darwin keeps the other guards in this file running in CI, which is where their
// value is. It does NOT weaken the lab: nothing in `run.mjs` changes, and the property still holds
// on the only platform that runs the lab. Making the scan portable so these can run everywhere is
// tracked separately — that is a fix to the scanner, not to the test.
export const hostProcessTable = {
  ...external,
  skip: process.platform === "darwin" ? false : "host process-table semantics differ off-darwin; the lab is macOS-only",
}
