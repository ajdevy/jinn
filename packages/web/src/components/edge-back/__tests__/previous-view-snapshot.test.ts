import { describe, expect, it } from 'vitest'
import { forgetViewsOverBudget, type RetainedView } from '../previous-view-snapshot'

const NODES = 100

/** Photographs of the given sizes, in the order they were taken. */
function trail(sizes: number[]): Map<string, RetainedView> {
  const views = new Map<string, RetainedView>()
  sizes.forEach((nodes, index) => views.set(`k${index}`, { clone: document.createElement('div'), nodes }))
  return views
}

const keysOf = (views: Map<string, RetainedView>) => [...views.keys()]

/**
 * One stop of the hook's lifecycle, in the order it runs there: retention
 * against where the cursor now stands, then the destination is read, then a
 * frame later the view standing here is photographed.
 *
 * Doing all three is the point. Filling the map once and evicting once hides
 * the failure this covers, because it never lets the cursor move after an
 * eviction has already happened.
 */
function stopAt(views: Map<string, RetainedView>, stack: string[], at: number, budget: number): string | null {
  forgetViewsOverBudget(views, stack, at, budget)
  const destination = at > 0 && views.has(stack[at - 1]) ? stack[at - 1] : null
  views.set(stack[at], { clone: document.createElement('div'), nodes: NODES })
  return destination
}

describe('forgetViewsOverBudget', () => {
  it('keeps every photograph while the total fits the budget', () => {
    const views = trail([100, 100, 100])

    forgetViewsOverBudget(views, ['k0', 'k1', 'k2'], 2, 500)

    expect(keysOf(views)).toEqual(['k0', 'k1', 'k2'])
  })

  it('counts nodes rather than entries, and drops what the gesture would want last', () => {
    const views = trail([100, 100, 100, 100])

    forgetViewsOverBudget(views, ['k0', 'k1', 'k2', 'k3'], 3, 250)

    // `k3` is the live view, whose copy the current drag cannot reveal, and `k0`
    // is four gestures away. `k2` is the destination and `k1` the stop after it.
    expect(keysOf(views)).toEqual(['k1', 'k2'])
  })

  it('never drops the view the drag would reveal, however small the budget', () => {
    const views = trail(Array.from({ length: 10 }, () => 100))

    forgetViewsOverBudget(views, keysOf(views), 2, 1)

    expect(keysOf(views)).toEqual(['k1'])
  })

  it('keeps the destination photographed at every stop of a walk back past the budget', () => {
    // Nine views against room for eight: the trail cannot be held whole, which
    // is the only case retention decides anything in. Walk it out and then all
    // the way back, and every stop still has the photograph of the next one.
    const stack = Array.from({ length: 9 }, (_, index) => `k${index}`)
    const budget = (stack.length - 1) * NODES
    const views = new Map<string, RetainedView>()
    for (let at = 0; at < stack.length; at += 1) stopAt(views, stack, at, budget)

    const destinations = []
    for (let at = stack.length - 2; at >= 1; at -= 1) destinations.push(stopAt(views, stack, at, budget))

    expect(destinations).toEqual(['k6', 'k5', 'k4', 'k3', 'k2', 'k1', 'k0'])
  })
})
