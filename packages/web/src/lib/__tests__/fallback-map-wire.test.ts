import { describe, expect, it } from 'vitest'
import {
  blankSourceProblem,
  mapNotAMappingProblem,
  modelMapEntryPath,
  modelMapPath,
  targetNotAModelIdProblem,
  unservedTargetProblem,
  unservedTargetWarning,
} from '@jinn/fallback-map-wire'

/* The bundle reaches the gateway's own problem strings, byte for byte.
 *
 * Every expectation below is a hard-coded literal rather than a call back into the
 * module, and that is the whole point: `packages/jinn`'s engine-fallback.test.ts
 * hard-codes the same sentences against the config loader. Both suites passing is
 * what proves the editor refuses a map entry in the words the loader would use. If
 * one side ever drifts, exactly one of the two suites goes red. */

describe('fallbackModelMap problem strings', () => {
  it('names the config path an operator would edit', () => {
    expect(modelMapPath('claude')).toBe('engines.claude.fallbackModelMap')
    expect(modelMapEntryPath('claude', 'claude-opus-5')).toBe('engines.claude.fallbackModelMap["claude-opus-5"]')
  })

  it('reports a map that is not a mapping, in the loader words', () => {
    expect(mapNotAMappingProblem('codex', ['haiku']))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got array)')
    expect(mapNotAMappingProblem('codex', 'haiku'))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got string)')
    // `typeof null` is "object", so null gets named rather than mislabelled.
    expect(mapNotAMappingProblem('codex', null))
      .toBe('engines.codex.fallbackModelMap must be a mapping of model id to model id (got null)')
  })

  it('reports a blank source and a target that is not a model id, in the loader words', () => {
    expect(blankSourceProblem('claude')).toBe('engines.claude.fallbackModelMap has a blank model id as a key')
    expect(targetNotAModelIdProblem('claude', 'opus', 3))
      .toBe('engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got number)')
    expect(targetNotAModelIdProblem('claude', 'opus', '  '))
      .toBe('engines.claude.fallbackModelMap["opus"] must be a nonempty model id (got string)')
  })

  it('reports a target the substitute does not serve — the one the editor renders', () => {
    const entry = { engine: 'claude', model: 'claude-opus-5', target: 'gpt-5.6-sol', substitute: 'grok' }

    expect(unservedTargetProblem(entry)).toBe(
      'engines.claude.fallbackModelMap["claude-opus-5"] maps to "gpt-5.6-sol", which engine "grok" does not serve',
    )
    // The runtime says the same thing and then what it did about it.
    expect(unservedTargetWarning(entry)).toBe(
      `${unservedTargetProblem(entry)} — running grok on its own default model instead.`,
    )
  })
})
