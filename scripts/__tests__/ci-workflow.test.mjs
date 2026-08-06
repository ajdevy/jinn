import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Spawned rather than imported: the checker's whole contract is its exit code.
const CHECKER = fileURLToPath(new URL("../check-required-jobs.mjs", import.meta.url))
const AGGREGATE_JOB = "all-checks-pass"

const workflow = fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")

// A top-level job key is indented exactly two spaces inside the `jobs:` block;
// step bodies and heredocs sit far deeper. That is enough to read this file, and
// a YAML parser is a root dependency the repository does not have.
function jobNames() {
  const lines = workflow.split("\n")
  const start = lines.indexOf("jobs:")
  assert.notEqual(start, -1, "ci.yml has no top-level `jobs:` block")

  const names = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const key = /^ {2}([\w-]+):\s*$/.exec(line)
    if (key) names.push(key[1])
  }
  return names
}

/** The lines belonging to one job, up to the next job or the next top-level key. */
function jobBlock(name) {
  const lines = workflow.split("\n")
  const start = lines.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `ci.yml has no \`${name}\` job`)

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join("\n")
}

function dependenciesOf(name) {
  const declared = /\n\s*needs: \[([^\]]*)\]/.exec(jobBlock(name))
  assert.ok(declared, `\`${name}\` declares no \`needs\``)
  return declared[1].split(",").map((job) => job.trim())
}

const succeeded = (...names) => Object.fromEntries(names.map((name) => [name, { result: "success", outputs: {} }]))

/** @param {Record<string, unknown> | undefined} results the `needs` context the job would see */
function check(results) {
  const env = { ...process.env }
  if (results === undefined) delete env.NEEDS_RESULTS
  else env.NEEDS_RESULTS = JSON.stringify(results)

  const result = spawnSync(process.execPath, [CHECKER], { encoding: "utf8", env })
  assert.notEqual(result.status, null, `the checker was killed by ${result.signal}`)
  return result
}

test("all-checks-pass depends on every other job in ci.yml", () => {
  const jobs = jobNames()
  assert.ok(jobs.includes(AGGREGATE_JOB), `ci.yml has no \`${AGGREGATE_JOB}\` job`)

  const expected = jobs.filter((job) => job !== AGGREGATE_JOB)
  assert.deepEqual(
    dependenciesOf(AGGREGATE_JOB).sort(),
    expected.sort(),
    `every job in ci.yml must be listed in \`${AGGREGATE_JOB}\`'s \`needs\`, or it sits outside branch protection`,
  )
})

test("all-checks-pass runs even when a dependency did not", () => {
  const block = jobBlock(AGGREGATE_JOB)

  // Without this the job is skipped the moment a dependency fails, and a
  // required check that never ran does not report as a red one.
  assert.match(block, /^\s*if: always\(\)$/m)
  assert.match(block, /NEEDS_RESULTS: \$\{\{ toJSON\(needs\) \}\}/)
  assert.match(block, /run: node scripts\/check-required-jobs\.mjs/)
})

test("every dependency succeeding passes the check", () => {
  const result = check(succeeded("typecheck", "docker"))
  assert.equal(result.status, 0, result.stderr)
})

for (const outcome of ["skipped", "cancelled", "failure"]) {
  test(`a ${outcome} dependency fails the check and is named`, () => {
    const results = succeeded("typecheck", "docker")
    results.e2e = { result: outcome, outputs: {} }

    const result = check(results)
    assert.equal(result.status, 1, `a ${outcome} dependency passed the check`)
    assert.match(result.stderr, new RegExp(`e2e: ${outcome}`))
    assert.doesNotMatch(result.stderr, /typecheck/, "only the jobs that did not succeed belong in the output")
  })
}

test("an empty dependency set fails the check", () => {
  // A `needs` list that lost its entries is not a green light; it is a gate
  // wired to nothing, and it would pass every run.
  assert.equal(check({}).status, 1)
})

test("a missing result blob fails the check", () => {
  assert.equal(check(undefined).status, 1)
})
