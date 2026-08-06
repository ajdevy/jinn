#!/usr/bin/env node
// Regenerates eslint-baseline.json: the grandfather list of files that predate
// the lint floor, recorded per file per rule. Re-applying `enforcement` on top
// of the config file cancels the existing overrides, so the tree is measured as
// it would be judged with an empty baseline.
//
// Deterministic and idempotent by construction: keys and rule names are sorted,
// paths are POSIX, and nothing but violations reaches the output.
import { writeFileSync } from "node:fs"
import { relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { ESLint } from "eslint"

import { CAPPED_RULES, LINTED, enforcement } from "../eslint.config.mjs"

const INSTRUCTIONS =
  "Every entry is code that predates the lint floor, exempt from exactly the rules listed. " +
  "To leave the list: split the function at its seams into named helpers, give the branchy part its own " +
  "function with an early return per case, hoist a nested loop or condition into a helper so the body reads " +
  "flat, group related parameters into one options object, await the promise or hand it to `void`. Then run " +
  "`node scripts/eslint-baseline.mjs` and commit the shrunken file. Add nothing here by hand — inline " +
  "eslint-disable comments are ignored outright, so this file is the only suppression channel, and " +
  "it is meant to shrink."

const root = fileURLToPath(new URL("..", import.meta.url))
const capped = new Set(CAPPED_RULES)

// `enforcement` is a typescript-eslint `ConfigArray`, which ESLint accepts as a
// flat config at runtime. The two packages declare `languageOptions` separately
// and only ESLint's carries an index signature, so the structural check fails on
// a difference that does not exist in the value.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: /** @type {import("eslint").Linter.Config[]} */ (enforcement),
})
const results = await eslint.lintFiles(LINTED)

const files = {}
for (const result of results) {
  const rules = result.messages
    .map((message) => message.ruleId)
    .filter((ruleId) => capped.has(ruleId))
  if (rules.length === 0) continue
  files[relative(root, result.filePath).split(sep).join("/")] = [...new Set(rules)].sort()
}

const sorted = Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file]]))
writeFileSync(
  new URL("../eslint-baseline.json", import.meta.url),
  `${JSON.stringify({ _instructions: INSTRUCTIONS, files: sorted }, null, 2)}\n`,
)

const violations = Object.values(sorted).reduce((total, rules) => total + rules.length, 0)
console.log(`eslint-baseline.json: ${Object.keys(sorted).length} files, ${violations} file+rule exemptions`)
