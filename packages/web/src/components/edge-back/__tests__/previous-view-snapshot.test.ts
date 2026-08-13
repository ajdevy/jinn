import { describe, expect, it } from 'vitest'
import { forgetViewsOverBudget, type RetainedView } from '../previous-view-snapshot'

/** Photographs of the given sizes, in the order they were taken — which is the
 *  order the eviction reads as least-recently-visited first. */
function trail(sizes: number[]): Map<string, RetainedView> {
  const views = new Map<string, RetainedView>()
  sizes.forEach((nodes, index) => views.set(`k${index}`, { clone: document.createElement('div'), nodes }))
  return views
}

const remaining = (views: Map<string, RetainedView>) => [...views.keys()]

describe('forgetViewsOverBudget', () => {
  it('keeps every photograph while the total fits the budget', () => {
    const views = trail([100, 100, 100])

    forgetViewsOverBudget(views, ['k1', 'k2'], 500)

    expect(remaining(views)).toEqual(['k0', 'k1', 'k2'])
  })

  it('counts nodes rather than entries, and drops the least recently visited first', () => {
    const views = trail([100, 100, 100, 100])

    forgetViewsOverBudget(views, ['k3'], 250)

    expect(remaining(views)).toEqual(['k2', 'k3'])
  })

  it('never drops the view the drag would reveal, however small the budget', () => {
    // The round-2 regression: a ten-entry trail walked back to index 2. The one
    // photograph `navigate(-1)` is about to land on is `k1`, and it is still
    // there whatever the budget says.
    const views = trail(Array.from({ length: 10 }, () => 100))

    forgetViewsOverBudget(views, ['k1', 'k2'], 1)

    expect(remaining(views)).toEqual(['k1', 'k2'])
  })
})
