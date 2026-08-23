import { describe, expect, it } from 'vitest'
import {
  addMapPair,
  allModelMapProblems,
  firstSubstitute,
  mapConfigValue,
  mapPairProblem,
  mapProblems,
  removeMapPair,
  setMapTarget,
  sourceOptionsFor,
  targetOptionsFor,
  type ModelMapPair,
  type ServedModels,
} from '../model-map-model'

const SERVED: ServedModels = {
  claude: ['claude-opus-5', 'claude-sonnet-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-luna'],
  grok: ['grok-build'],
}

const ctx = (substitute: string | null, engine = 'claude') => ({ engine, substitute, served: SERVED })

describe('firstSubstitute', () => {
  it('is the head of the chain, because that is the engine a turn actually lands on', () => {
    expect(firstSubstitute(['codex', 'grok'])).toBe('codex')
    expect(firstSubstitute([])).toBeNull()
  })
})

describe('the options each control may offer', () => {
  it('targets are exactly what the first substitute serves, and nothing without one', () => {
    expect(targetOptionsFor(SERVED, 'codex')).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
    expect(targetOptionsFor(SERVED, null)).toEqual([])
    expect(targetOptionsFor(SERVED, 'pi')).toEqual([])
  })

  it('sources are this engine own models, minus the ones already mapped', () => {
    expect(sourceOptionsFor(SERVED, 'claude', [])).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(sourceOptionsFor(SERVED, 'claude', [['claude-opus-5', 'gpt-5.6-sol']])).toEqual(['claude-sonnet-5'])
  })
})

describe('editing rows', () => {
  const pairs: ModelMapPair[] = [['claude-opus-5', 'gpt-5.6-sol'], ['claude-sonnet-5', 'gpt-5.6-luna']]

  it('adds trimmed, removes by index, and retargets without touching the source', () => {
    expect(addMapPair([], '  claude-opus-5 ', ' gpt-5.6-sol ')).toEqual([['claude-opus-5', 'gpt-5.6-sol']])
    expect(removeMapPair(pairs, 0)).toEqual([['claude-sonnet-5', 'gpt-5.6-luna']])
    expect(setMapTarget(pairs, 1, 'gpt-5.6-sol')).toEqual([
      ['claude-opus-5', 'gpt-5.6-sol'],
      ['claude-sonnet-5', 'gpt-5.6-sol'],
    ])
  })

  it('leaves the input alone — every edit is a new list', () => {
    removeMapPair(pairs, 0)
    setMapTarget(pairs, 0, 'grok-build')
    expect(pairs).toEqual([['claude-opus-5', 'gpt-5.6-sol'], ['claude-sonnet-5', 'gpt-5.6-luna']])
  })
})

describe('mapConfigValue', () => {
  it('is the mapping in row order', () => {
    expect(mapConfigValue([['claude-opus-5', 'gpt-5.6-sol']])).toEqual({ 'claude-opus-5': 'gpt-5.6-sol' })
  })

  it('is null once emptied, because {} would merge to no change and leave the block on disk', () => {
    expect(mapConfigValue([])).toBeNull()
  })
})

describe('what blocks a save', () => {
  it('passes an entry the substitute serves', () => {
    expect(mapPairProblem(ctx('codex'), [['claude-opus-5', 'gpt-5.6-sol']], 0)).toBeNull()
  })

  it('refuses an entry the substitute does not serve, in the config loader words', () => {
    expect(mapPairProblem(ctx('grok'), [['claude-opus-5', 'gpt-5.6-sol']], 0)).toBe(
      'engines.claude.fallbackModelMap["claude-opus-5"] maps to "gpt-5.6-sol", which engine "grok" does not serve',
    )
  })

  it('refuses a blank source or a blank target, in the config loader words', () => {
    expect(mapPairProblem(ctx('codex'), [['   ', 'gpt-5.6-sol']], 0))
      .toBe('engines.claude.fallbackModelMap has a blank model id as a key')
    expect(mapPairProblem(ctx('codex'), [['claude-opus-5', '']], 0))
      .toBe('engines.claude.fallbackModelMap["claude-opus-5"] must be a nonempty model id (got string)')
  })

  it('refuses a second row claiming a source the first already has, which the save would collapse', () => {
    const dupes: ModelMapPair[] = [['claude-opus-5', 'gpt-5.6-sol'], ['claude-opus-5', 'gpt-5.6-luna']]

    expect(mapPairProblem(ctx('codex'), dupes, 0)).toBeNull()
    expect(mapPairProblem(ctx('codex'), dupes, 1)).toContain('is set twice')
  })

  it('judges nothing without a chain: there is no substitute for the target to be wrong for', () => {
    expect(mapPairProblem(ctx(null), [['claude-opus-5', 'anything-at-all']], 0)).toBeNull()
  })

  it('judges nothing against a substitute the registry lists no models for', () => {
    const served: ServedModels = { claude: ['claude-opus-5'], codex: [] }
    expect(mapPairProblem({ engine: 'claude', substitute: 'codex', served }, [['claude-opus-5', 'whatever']], 0))
      .toBeNull()
  })
})

describe('allModelMapProblems', () => {
  it('is empty for a config with no maps at all', () => {
    expect(allModelMapProblems({ claude: { fallback: ['codex'] } }, SERVED)).toEqual([])
  })

  it('finds a stale entry on any engine, keyed to that engine own config path', () => {
    const engines = {
      claude: { fallback: ['grok'], fallbackModelMap: { 'claude-opus-5': 'gpt-5.6-sol' } },
      codex: { fallback: ['claude'], fallbackModelMap: { 'gpt-5.6-sol': 'claude-opus-5' } },
    }

    expect(allModelMapProblems(engines, SERVED)).toEqual([
      'engines.claude.fallbackModelMap["claude-opus-5"] maps to "gpt-5.6-sol", which engine "grok" does not serve',
    ])
  })
})

describe('mapProblems', () => {
  it('reports every broken row and drops the sound ones', () => {
    const pairs: ModelMapPair[] = [['claude-opus-5', 'gpt-5.6-sol'], ['claude-sonnet-5', 'nope']]

    expect(mapProblems(ctx('codex'), pairs)).toEqual([
      'engines.claude.fallbackModelMap["claude-sonnet-5"] maps to "nope", which engine "codex" does not serve',
    ])
  })
})
