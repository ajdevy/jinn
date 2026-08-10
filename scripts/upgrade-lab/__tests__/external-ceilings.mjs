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
