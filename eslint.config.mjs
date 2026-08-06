import comments from "@eslint-community/eslint-plugin-eslint-comments"
import tseslint from "typescript-eslint"

import baseline from "./eslint-baseline.json" with { type: "json" }

// Type-aware lint needs every linted file to belong to a tsconfig. These trees
// are exactly the ones their package tsconfigs already cover.
export const LINTED = [
  "packages/jinn/bin/**/*.ts",
  "packages/jinn/src/**/*.ts",
  "packages/web/**/*.{ts,tsx}",
  "packages/gateway-events/src/**/*.ts",
]

const TESTS = ["packages/*/**/__tests__/**/*.{ts,tsx}", "packages/*/**/*.test.{ts,tsx}"]

/**
 * The floor. Every one of these is an error, never a warning, because a warning
 * is a number that grows.
 *
 * When one fires, the fix is to change the code, not the config. Split the
 * function at its seams into named helpers; give the branchy part its own
 * function with an early return per case; hoist a nested loop or condition into
 * a helper so the body reads flat; group related parameters into one options
 * object; await the promise, or hand it to `void` if the result is genuinely
 * not wanted. `eslint-baseline.json` grandfathers code that predates this
 * config and is the only place a violation may be recorded — inline
 * `eslint-disable` comments for these rules are rejected by the two
 * `eslint-comments` rules below.
 */
const CAPS = {
  complexity: ["error", { max: 10 }],
  "max-depth": ["error", { max: 3 }],
  "max-lines-per-function": ["error", { max: 50 }],
  "max-params": ["error", { max: 5 }],
  "@typescript-eslint/no-floating-promises": "error",
  // The `_name` prefix is this codebase's existing marker for a binding a
  // signature forces to exist and the body has no use for. Honouring it keeps
  // the rule pointed at real dead code.
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
}

export const CAPPED_RULES = Object.keys(CAPS)

// `describe` and `it` bodies are functions, so the two size/shape caps would
// make every long test file a violator for no signal — nobody splits a test
// because its `describe` block is long. The other four stay on: an un-awaited
// assertion is a real bug and a classic source of flakes.
const CAPS_OFF_IN_TESTS = ["complexity", "max-lines-per-function"]

/**
 * The rules themselves, without the grandfather overrides. `scripts/eslint-baseline.mjs`
 * re-applies exactly this to measure the tree as it would be judged with an
 * empty baseline.
 */
export const enforcement = tseslint.config(
  {
    files: LINTED,
    extends: [tseslint.configs.base],
    plugins: { "@eslint-community/eslint-comments": comments },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      ...CAPS,
      // The grandfather file is the only suppression channel: name one of the
      // capped rules in a disable comment and lint fails, bare `eslint-disable`
      // included. Restricted to those six rather than banning every disable, so
      // a rule this config does not enforce stays suppressible inline.
      "@eslint-community/eslint-comments/no-restricted-disable": ["error", ...CAPPED_RULES],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
  {
    files: TESTS,
    rules: Object.fromEntries(CAPS_OFF_IN_TESTS.map((rule) => [rule, "off"])),
  },
)

/**
 * One override per grandfathered file+rule, so a file excused for `complexity`
 * still fails on `max-params`.
 */
const grandfathered = Object.entries(baseline.files).map(([file, rules]) => ({
  files: [file],
  rules: Object.fromEntries(rules.map((rule) => [rule, "off"])),
}))

export default [
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/.turbo/**",
      "packages/jinn/template/**",
      // ICI-709 owns bringing `e2e/`, `scripts/`, `tools/` and the build scripts
      // into a tsconfig. Type-aware lint cannot precede that.
      "e2e/**",
      "scripts/**",
      "tools/**",
      "packages/*/scripts/**",
      "**/*.{js,cjs,mjs}",
    ],
  },
  ...enforcement,
  ...grandfathered,
]
