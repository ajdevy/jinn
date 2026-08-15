import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const EVIDENCE = fileURLToPath(new URL("../deliverable-evidence.mjs", import.meta.url))

/** realpath because macOS hands out a symlinked temp root, and `write` compares
 *  a resolved path against the home it was given. */
function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function run(...args) {
  const result = spawnSync(process.execPath, [EVIDENCE, ...args], { encoding: "utf8" })
  assert.notEqual(result.status, null, `the script was killed by ${result.signal}`)
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

/** A workspace home holding one delivered file, plus the manifest path beside it. */
function fixture(body = "# a Note the verifier will never read\n") {
  const home = tmp("evidence-home-")
  const repo = tmp("evidence-repo-")
  fs.writeFileSync(path.join(home, "note.md"), body)
  return { home, repo, manifest: path.join(repo, ".jinn-build", "deliverable-evidence.json") }
}

function writeManifest(manifest, value) {
  fs.mkdirSync(path.dirname(manifest), { recursive: true })
  fs.writeFileSync(manifest, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

const VALID = {
  todoId: "AAA-802",
  summary: "one Note delivered into the workspace",
  entries: [{ path: "note.md", sha256: "a".repeat(64), bytes: 12 }],
}

test("write records a sha256 equal to shasum -a 256 of the delivered file", () => {
  const { home, manifest } = fixture()
  const written = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "a Note", "note.md")
  assert.equal(written.status, 0, written.out)

  const shasum = spawnSync("shasum", ["-a", "256", path.join(home, "note.md")], { encoding: "utf8" })
  assert.equal(shasum.status, 0, shasum.stderr)
  const expected = shasum.stdout.trim().split(/\s+/)[0]

  const record = JSON.parse(fs.readFileSync(manifest, "utf8"))
  assert.deepEqual(record.entries, [
    { path: "note.md", sha256: expected, bytes: fs.statSync(path.join(home, "note.md")).size },
  ])
  assert.equal(record.todoId, "AAA-802")
  assert.equal(record.summary, "a Note")
})

for (const [name, arg] of [
  ["a path containing ..", "../escape.md"],
  ["an absolute path outside the given home", "/etc/hosts"],
  ["a path under secrets/", "secrets/api-keys.json"],
]) {
  test(`write refuses ${name}`, () => {
    const { home, manifest } = fixture()
    const refused = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "s", arg)
    assert.notEqual(refused.status, 0, `expected a refusal, got: ${refused.out}`)
    // The refusal has to name the path it turned down; a non-zero exit alone is
    // also what a missing script produces.
    assert.ok(refused.out.includes(arg), `the refusal does not name ${arg}: ${refused.out}`)
    assert.equal(fs.existsSync(manifest), false, "a refused write must leave no manifest behind")
  })
}

test("write refuses a link whose file physically lives under secrets/", () => {
  const { home, manifest } = fixture()
  fs.mkdirSync(path.join(home, "secrets"))
  fs.writeFileSync(path.join(home, "secrets", "fake.json"), '{"token":"x"}\n')
  fs.symlinkSync(path.join(home, "secrets", "fake.json"), path.join(home, "innocent.md"))

  const refused = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "s", "innocent.md")
  assert.notEqual(refused.status, 0, `a secret was hashed through a link: ${refused.out}`)
  assert.match(refused.out, /secrets\//)
  assert.equal(fs.existsSync(manifest), false, "a refused write must leave no manifest behind")
})

test("check refuses a secrets/ entry spelled with a leading dot segment", () => {
  const { manifest } = fixture()
  writeManifest(manifest, { ...VALID, entries: [{ path: "./secrets/fake.json", sha256: "a".repeat(64), bytes: 12 }] })
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.notEqual(checked.status, 0, `a secret passed as evidence: ${checked.out}`)
})

test("check exits 0 on a valid manifest", () => {
  const { manifest } = fixture()
  writeManifest(manifest, VALID)
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(checked.status, 0, checked.out)
})

test("check names each way a manifest can be wrong, and names them distinctly", () => {
  const cases = {
    missing: null,
    malformed: "{ not json",
    empty: { ...VALID, entries: [] },
    badHash: { ...VALID, entries: [{ path: "note.md", sha256: "abc", bytes: 12 }] },
    secrets: { ...VALID, entries: [{ path: "secrets/api-keys.json", sha256: "a".repeat(64), bytes: 12 }] },
    mismatch: { ...VALID, todoId: "AAA-101" },
  }

  const reasons = new Map()
  for (const [name, value] of Object.entries(cases)) {
    const { manifest } = fixture()
    if (value !== null) writeManifest(manifest, value)
    const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
    assert.notEqual(checked.status, 0, `${name}: expected a non-zero exit, got: ${checked.out}`)
    reasons.set(name, checked.out.trim())
  }

  assert.equal(new Set(reasons.values()).size, reasons.size, `messages repeat: ${[...reasons.values()].join(" | ")}`)
})

test("check opens no path but the manifest — a deliverable that is gone still passes", () => {
  const { manifest } = fixture()
  writeManifest(manifest, { ...VALID, entries: [{ path: "vanished/gone.md", sha256: "b".repeat(64), bytes: 7 }] })
  const checked = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(checked.status, 0, `check read the deliverable instead of only the manifest: ${checked.out}`)
})

// The shape that parked a finished Todo in `blocked`: everything delivered lives
// in the workspace, the product diff is empty, and the verifier has nothing in
// the repository to rule on. Absent the manifest that is still true.
test("a workspace-only deliverable with an empty product diff reaches a verdict", () => {
  const { home, manifest } = fixture()

  const beforeTheChange = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.notEqual(beforeTheChange.status, 0, "with no evidence the verifier must not be able to rule")

  const written = run("write", "--todo", "AAA-802", "--home", home, "--manifest", manifest, "--summary", "a Note", "note.md")
  assert.equal(written.status, 0, written.out)

  const verdict = run("check", "--todo", "AAA-802", "--manifest", manifest)
  assert.equal(verdict.status, 0, verdict.out)
  assert.match(verdict.out, /note\.md/)
})

const DOCS_ONLY = ["docs/architecture.md", ".jinn-build/notes.json"]
const TOUCHES_SOURCE = ["docs/architecture.md", "packages/gateway/src/server.ts"]

test("route honours a workspace declaration when the diff is empty or non-shipping", () => {
  for (const changed of [[], DOCS_ONLY]) {
    const routed = run("route", "--declared", "workspace", ...changed)
    assert.equal(routed.status, 0, `a diff of ${JSON.stringify(changed)} is not shipping: ${routed.out}`)
  }
})

test("route refuses a workspace declaration whose diff touches a shipping path", () => {
  const routed = run("route", "--declared", "workspace", ...TOUCHES_SOURCE)
  // Distinct from `fail`, so the pipeline can tell a false declaration apart
  // from a mistyped call.
  assert.equal(routed.status, 2, `expected the route-mismatch exit, got ${routed.status}: ${routed.out}`)
  assert.ok(routed.out.includes("packages/gateway/src/server.ts"), `the refusal does not name the offending file: ${routed.out}`)
})

test("route names every offending file, not just the first", () => {
  const offenders = ["packages/gateway/src/server.ts", "scripts/ratchet.mjs", "package.json"]
  const routed = run("route", "--declared", "workspace", "docs/architecture.md", ...offenders)
  assert.equal(routed.status, 2, routed.out)
  for (const offender of offenders) {
    assert.ok(routed.out.includes(offender), `${offender} is not named: ${routed.out}`)
  }
})

test("route treats a top-level directory it has never heard of as shipping", () => {
  const routed = run("route", "--declared", "workspace", "brand-new-top-level/thing.ts")
  assert.equal(routed.status, 2, `an unknown top-level directory was let through as non-shipping: ${routed.out}`)
})

test("route judges a path by the file it names, not by how it is spelled", () => {
  const routed = run("route", "--declared", "workspace", "./packages/gateway/src/server.ts")
  assert.equal(routed.status, 2, `a leading dot segment slipped past the shipping check: ${routed.out}`)
})

test("route lets the repo declaration through whatever the diff holds", () => {
  for (const changed of [DOCS_ONLY, TOUCHES_SOURCE]) {
    const routed = run("route", "--declared", "repo", ...changed)
    assert.equal(routed.status, 0, `the ordinary route must not be blocked: ${routed.out}`)
  }
})

test("route refuses a --declared value that is neither repo nor workspace", () => {
  const missing = run("route", "packages/gateway/src/server.ts")
  assert.equal(missing.status, 1, `expected a usage failure, got ${missing.status}: ${missing.out}`)

  const nonsense = run("route", "--declared", "workspaces", "docs/architecture.md")
  assert.equal(nonsense.status, 1, `expected a usage failure, got ${nonsense.status}: ${nonsense.out}`)
  assert.match(nonsense.out, /usage:/)
})
