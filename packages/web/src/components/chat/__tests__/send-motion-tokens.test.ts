import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const GLOBALS = readFileSync(path.resolve(__dirname, '../../../routes/globals.css'), 'utf8')

/** The palette lives in FOUR blocks, not two: a token defined only in the
 *  `[data-theme]` pair is missing for a reader who never picked a theme and is
 *  on the OS preference. Each expected value is that block's own `--system-red`
 *  at the alpha that block already uses to relate `--accent-fill` to `--accent`,
 *  which is why the light media block is 0.12 and not 0.14. */
const DANGER_FILL_BY_BLOCK: Array<[string, string]> = [
  [':root, [data-theme="dark"]', 'rgba(224,103,90,0.14)'],
  ['[data-theme="light"]', 'rgba(178,59,51,0.14)'],
  ['@media (prefers-color-scheme: light)', 'rgba(178,59,51,0.12)'],
  ['@media (prefers-color-scheme: dark)', 'rgba(224,103,90,0.14)'],
]

/** Everything from the opening of `selector` to the next block at the same
 *  nesting depth, so an assertion about one palette cannot be satisfied by a
 *  neighbour's declaration. */
function block(selector: string): string {
  const start = GLOBALS.indexOf(selector)
  expect(start, `${selector} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = GLOBALS.indexOf('{', start); i < GLOBALS.length; i++) {
    if (GLOBALS[i] === '{') depth++
    else if (GLOBALS[i] === '}' && --depth === 0) return GLOBALS.slice(start, i)
  }
  throw new Error(`unterminated block for ${selector}`)
}

describe('--danger-fill', () => {
  it.each(DANGER_FILL_BY_BLOCK)('is defined in %s', (selector, value) => {
    expect(block(selector)).toContain(`--danger-fill: ${value};`)
  })

  it('is the only source of the failed bubble colour — no hardcoded value in the rules', () => {
    const rule = block('.user-msg-bubble[data-send-state="failed"]')
    expect(rule).toContain('var(--danger-fill)')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })
})

describe('enter motion', () => {
  it.each([
    ['.user-msg-bubble[data-msg-enter]', 'jinn-msg-send-in', '--duration-base'],
    ['.assistant-transcript[data-msg-enter]', 'jinn-msg-receive-in', '--duration-slow'],
  ])('%s animates with a duration token, never a literal', (selector, keyframes, duration) => {
    const rule = block(selector)
    expect(rule).toContain(`animation: ${keyframes} var(${duration}) var(--ease-smooth) backwards`)
    expect(rule).not.toMatch(/\d+m?s/)
  })

  it('switches both enter animations off under reduced motion', () => {
    // Both end on the resting state, so `animation: none` is safe here — unlike
    // the view transitions at the top of the motion system, which must collapse
    // to the instant token instead or their snapshot never unfreezes.
    expect(GLOBALS).toContain(
      '@media (prefers-reduced-motion: reduce) {\n  .user-msg-bubble[data-msg-enter], .assistant-transcript[data-msg-enter] { animation: none; }\n}',
    )
  })

  it('animates an arriving tool call with a duration token and no literal', () => {
    const rule = block('.tool-arrive {')
    expect(rule).toContain('animation: jinn-dispatch-rise var(--duration-base) var(--ease-smooth) backwards')
    // The `--arrive-delay` fallback is a stagger, not a duration, and matches
    // what every other arrival rule in this file already writes.
    expect(rule).not.toMatch(/animation:[^;]*\d+m?s/)
  })

  it('switches the tool-call entrance off under reduced motion', () => {
    expect(GLOBALS).toContain(
      '@media (prefers-reduced-motion: reduce) {\n  .tool-arrive { animation: none; }\n}',
    )
  })

  it('leaves the state transitions to the existing token block rather than a new rule', () => {
    // globals.css redefines --duration-fast|base|slow to --duration-instant under
    // reduced motion, so a transition authored with them collapses for free.
    const bubble = block('.user-msg-bubble {')
    expect(bubble).toContain('transition: opacity var(--duration-fast) var(--ease-smooth)')
    expect(bubble).not.toMatch(/\d+m?s/)
    expect(GLOBALS).not.toContain('.user-msg-bubble { transition: none')
  })
})
