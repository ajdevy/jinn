#!/usr/bin/env node
// The decision behind `all-checks-pass`, the one status check branch protection
// requires on main. It reads that job's `needs` context, where a job whose own
// dependency failed is reported as `skipped` — and a required check that never
// ran does not read as a red one. So only `success` passes here.
const blob = process.env.NEEDS_RESULTS
if (!blob) {
  console.error("NEEDS_RESULTS is empty. The job has to pass `NEEDS_RESULTS: ${{ toJSON(needs) }}` in its `env`.")
  process.exit(1)
}

const results = Object.entries(JSON.parse(blob))
if (results.length === 0) {
  // A `needs` list that lost its entries would pass every run. That is a gate
  // wired to nothing, not a green build.
  console.error("No dependency results. `all-checks-pass` must list every other job in ci.yml under `needs`.")
  process.exit(1)
}

// `skipped` never ran and `cancelled` stopped before it could, so neither one
// proved anything.
const unfinished = results.filter(([, job]) => job.result !== "success")
if (unfinished.length > 0) {
  console.error("These required jobs did not succeed:")
  for (const [name, job] of unfinished) console.error(`  ${name}: ${job.result}`)
  process.exit(1)
}

console.log(`All ${results.length} required jobs succeeded.`)
