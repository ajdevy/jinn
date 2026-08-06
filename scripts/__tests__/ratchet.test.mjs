import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Spawned with a temp repository as its cwd, so the path has to be absolute.
const RATCHET = fileURLToPath(new URL("../ratchet.mjs", import.meta.url))

// Nothing here may depend on the developer's git config.
/** @type {NodeJS.ProcessEnv} */
const HERMETIC = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=ratchet", "-c", "user.email=ratchet@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    env: HERMETIC,
  })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function ratchet(cwd, ...args) {
  const result = spawnSync(process.execPath, [RATCHET, ...args], { cwd, encoding: "utf8", env: HERMETIC })
  assert.notEqual(result.status, null, `the ratchet was killed by ${result.signal}`)
  assert.ok(result.status === 0 || result.status === 1, `unexpected exit ${result.status}: ${result.stderr}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** A file of exactly `count` lines whose content is irrelevant to every rule here. */
function source(count) {
  return `${Array.from({ length: count }, (_, index) => `export const value${index} = ${index}`).join("\n")}\n`
}

function write(root, relPath, content) {
  const target = path.join(root, relPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function writeExemptions(root, files) {
  write(root, "eslint-baseline.json", `${JSON.stringify({ files }, null, 2)}\n`)
}

function readBaseline(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "size-baseline.json"), "utf8"))
}

/** The scan reads `git ls-files`, so a file only exists once it is staged. */
function track(root) {
  git(root, "add", "--force", "-A")
}

/**
 * A repository whose committed baseline the tool itself wrote, which is the
 * state CI checks out.
 */
function seeded(files, exemptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-"))
  git(root, "init", "-b", "main")
  for (const [relPath, content] of Object.entries(files)) write(root, relPath, content)
  writeExemptions(root, exemptions)
  track(root)
  const seed = ratchet(root)
  assert.equal(seed.status, 0, `seeding failed: ${seed.stdout}${seed.stderr}`)
  track(root)
  return root
}

test("a clean checkout passes and reports what it tracks", () => {
  const root = seeded({ "scripts/big.mjs": source(400), "scripts/small.mjs": source(10) })

  const { status, stdout } = ratchet(root, "--check")

  assert.equal(status, 0, stdout)
  assert.match(stdout, /2 files scanned/)
  assert.match(stdout, /1 baselined file/)
  assert.match(stdout, /400 budgeted lines/)
})

test("growing a baselined file names the file, its baseline, its new count and the delta", () => {
  const root = seeded({ "scripts/big.mjs": source(400) })
  write(root, "scripts/big.mjs", source(401))

  const { status, stdout } = ratchet(root, "--check")

  assert.equal(status, 1, stdout)
  assert.match(stdout, /^scripts\/big\.mjs$/m)
  assert.match(stdout, /400 → 401 lines \(\+1\)/)
  assert.match(stdout, /Split the file by responsibility/)
})

test("a new file over the limit fails and one at the limit passes", () => {
  const root = seeded({ "scripts/big.mjs": source(400) })
  write(root, "scripts/added.mjs", source(301))
  track(root)

  const over = ratchet(root, "--check")
  assert.equal(over.status, 1, over.stdout)
  assert.match(over.stdout, /^scripts\/added\.mjs$/m)
  assert.match(over.stdout, /exceeds the 300-line limit: 301 lines \(\+1\)/)
  assert.match(over.stdout, /Split the file by responsibility/)

  write(root, "scripts/added.mjs", source(300))
  const atLimit = ratchet(root, "--check")
  assert.equal(atLimit.status, 0, atLimit.stdout)
})

test("a lint exemption the size baseline does not record fails, naming the file and the rule", () => {
  const root = seeded({ "scripts/small.mjs": source(10) })
  writeExemptions(root, { "scripts/small.mjs": ["complexity"] })

  const { status, stdout } = ratchet(root, "--check")

  assert.equal(status, 1, stdout)
  assert.match(stdout, /^scripts\/small\.mjs$/m)
  assert.match(stdout, /\+complexity/)
  assert.match(stdout, /split the file by responsibility/)
})

test("a rule added to a file the size baseline already records still fails", () => {
  const root = seeded({ "scripts/small.mjs": source(10) }, { "scripts/small.mjs": ["complexity"] })
  writeExemptions(root, { "scripts/small.mjs": ["complexity", "max-depth"] })

  const { status, stdout } = ratchet(root, "--check")

  assert.equal(status, 1, stdout)
  assert.match(stdout, /\+max-depth/)
  assert.doesNotMatch(stdout, /\+complexity/)
})

test("a package's own scripts are scanned, so their exemptions cannot skip the mirror", () => {
  const root = seeded({ "packages/jinn/scripts/build.mjs": source(10) })
  writeExemptions(root, { "packages/jinn/scripts/build.mjs": ["complexity"] })

  const { status, stdout } = ratchet(root, "--check")

  assert.equal(status, 1, stdout)
  assert.match(stdout, /^packages\/jinn\/scripts\/build\.mjs$/m)
  assert.match(stdout, /\+complexity/)
})

test("shrinking is stale until `pnpm ratchet` rewrites the baseline downward", () => {
  const root = seeded({ "scripts/big.mjs": source(400) })
  write(root, "scripts/big.mjs", source(380))

  const stale = ratchet(root, "--check")
  assert.equal(stale.status, 1, stale.stdout)
  assert.match(stale.stdout, /shrank: 400 → 380 lines \(-20\)/)
  assert.match(stale.stdout, /run `pnpm ratchet` and commit size-baseline\.json/)
  assert.match(stale.stdout, /Split the file by responsibility/)
  assert.equal(readBaseline(root).files["scripts/big.mjs"].lines, 400, "--check must never write")

  const rewritten = ratchet(root)
  assert.equal(rewritten.status, 0, rewritten.stdout)
  assert.equal(readBaseline(root).files["scripts/big.mjs"].lines, 380)
  assert.equal(ratchet(root, "--check").status, 0)
})

test("`pnpm ratchet` refuses to widen a budget, so growth cannot be laundered through it", () => {
  const root = seeded({ "scripts/big.mjs": source(400) })
  write(root, "scripts/big.mjs", source(401))

  const { status, stdout } = ratchet(root)

  assert.equal(status, 1, stdout)
  assert.equal(readBaseline(root).files["scripts/big.mjs"].lines, 400)
})

test("regeneration is idempotent, sorted and POSIX-pathed", () => {
  const root = seeded(
    {
      "scripts/b.mjs": source(400),
      "packages/web/src/a.tsx": source(500),
      "scripts/small.mjs": source(10),
    },
    { "scripts/small.mjs": ["complexity"] },
  )

  const first = fs.readFileSync(path.join(root, "size-baseline.json"), "utf8")
  assert.equal(ratchet(root).status, 0)
  const second = fs.readFileSync(path.join(root, "size-baseline.json"), "utf8")

  assert.equal(second, first)
  assert.deepEqual(Object.keys(readBaseline(root).files), [
    "packages/web/src/a.tsx",
    "scripts/b.mjs",
    "scripts/small.mjs",
  ])
  // Under the limit, so it carries its exemptions and no budget to grow into.
  assert.deepEqual(readBaseline(root).files["scripts/small.mjs"], { exempt: ["complexity"] })
})

test("deleting a baselined file passes the check, and `pnpm ratchet` drops the entry", () => {
  const root = seeded({ "scripts/big.mjs": source(400), "scripts/other.mjs": source(500) })
  fs.rmSync(path.join(root, "scripts/big.mjs"))

  const { status, stdout } = ratchet(root, "--check")
  assert.equal(status, 0, stdout)

  assert.equal(ratchet(root).status, 0)
  assert.equal(readBaseline(root).files["scripts/big.mjs"], undefined)
  assert.equal(readBaseline(root).files["scripts/other.mjs"].lines, 500)
})

test("--list ranks the files carrying a budget, largest first", () => {
  const root = seeded({ "scripts/b.mjs": source(400), "scripts/a.mjs": source(500) })

  const { status, stdout } = ratchet(root, "--list")

  assert.equal(status, 0, stdout)
  assert.match(stdout, /500\s+scripts\/a\.mjs[\s\S]*400\s+scripts\/b\.mjs/)
})
