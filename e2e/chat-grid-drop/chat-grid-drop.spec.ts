import { expect, test } from '@playwright/test'
import { cellRectForIndex } from '../../packages/web/src/routes/chat/grid-cells'
import { artifactPath, openGridPage, openSeededGridPage } from './chat-grid-drop.context'
import {
  describeRect,
  dragSession,
  dragSessionToRightQuarter,
  expectGeometryMatch,
  expectNoDropOverlay,
  rect,
  rectDelta,
  seededSessionIds,
  setWorkingSet,
  settledGridGeometry,
  type DropRegion,
} from './chat-grid-drop.helpers'

test('real pointer preview matches the 2-to-3 pane right-region result', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { video: true, clearWorkingSet: true })

  const [sessionA, sessionB, sessionC] = await seededSessionIds(page)

  await page.locator(`[data-chat-session-row="${sessionA}"]`).first().click()
  await expect(page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${sessionA}"])`)).toBeVisible()
  await dragSessionToRightQuarter(page, sessionB, sessionA)
  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)

  const geometry = await dragSessionToRightQuarter(page, sessionC, sessionB)
  const delta = rectDelta(geometry.preview, geometry.result)
  const evidence = `preview ${describeRect(geometry.preview)} vs result ${describeRect(geometry.result)}; delta ${JSON.stringify(delta)}`
  console.log(`PLA-174 geometry: ${evidence}`)

  for (const [axis, value] of Object.entries(delta)) {
    expect(Math.abs(value), `${evidence}; ${axis} exceeded 1px`).toBeLessThanOrEqual(1)
  }
  await context.close()
})

for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
  test(`grid-cell oracle reproduces rendered panes at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    const { context, page } = await openGridPage(browser, { viewport })
    const ids = await seededSessionIds(page)

    const renderedCounts = viewport.width === 1440 ? [2, 3, 4] : [2, 3, 5]
    for (const count of renderedCounts) {
      const seeded = await openSeededGridPage(context, ids.slice(0, count))

      const geometry = await settledGridGeometry(seeded, count)
      const spacing = await seeded.getByTestId('chat-grid').evaluate((element) => (
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--space-2'))
      ))

      geometry.panes.forEach((pane, index) => {
        const expected = cellRectForIndex(index, count, geometry.grid, {
          w: viewport.width,
          h: viewport.height,
        }, { padding: spacing, gap: spacing })
        const delta = rectDelta(expected, pane)
        for (const [axis, value] of Object.entries(delta)) {
          expect(Math.abs(value), `${count} panes, index ${index}, ${axis}`).toBeLessThanOrEqual(1)
        }
      })
      await seeded.close()
    }
    await context.close()
  })

  test(`preview simulation matches pointer drops at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const { context, page } = await openGridPage(browser, { viewport })
    const ids = await seededSessionIds(page)
    const cases: Array<{ count: number; region: DropRegion; target: number }> = [
      { count: 2, region: 'left', target: 0 },
      { count: 2, region: 'right', target: 1 },
      { count: 2, region: 'between', target: 0 },
      { count: 3, region: 'top', target: 0 },
      // The pane's bottom quarter is the composer, covered by the rejection journey below.
      { count: 3, region: 'end', target: 2 },
      { count: 4, region: 'right', target: 1 },
    ]
    if (viewport.width >= 1920) cases.push({ count: 5, region: 'left', target: 0 })

    for (const scenario of cases) {
      console.log(`PLA-174 matrix: ${viewport.width}x${viewport.height} ${scenario.count} panes ${scenario.region}`)
      await setWorkingSet(page, ids.slice(0, scenario.count))
      const geometry = await dragSession(
        page,
        ids[scenario.count],
        ids[scenario.target],
        scenario.region,
        scenario.region === 'end'
          ? scenario.count
          : scenario.target + (scenario.region === 'right' || scenario.region === 'bottom' || scenario.region === 'between' ? 1 : 0),
      )
      expectGeometryMatch(
        geometry.preview,
        geometry.result,
        `${scenario.count} panes ${scenario.region} at ${viewport.width}x${viewport.height}`,
      )
    }
    await context.close()
  })
}

test('the composer clears a prior pane preview and rejects the drop', async ({ browser }) => {
  const { context, page } = await openGridPage(browser)
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 2))

  const source = page.locator(`[data-chat-session-row="${ids[2]}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[0]}"])`)
  const composer = target.locator('[data-chat-composer]')
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  const composerBox = await composer.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  expect(composerBox).not.toBeNull()

  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 3, { steps: 16 })
  await expect(page.getByTestId('chat-grid-drop-zone')).toBeVisible()
  await page.mouse.move(composerBox!.x + composerBox!.width / 2, composerBox!.y + composerBox!.height / 2, { steps: 8 })
  await expectNoDropOverlay(page)
  await page.mouse.up()

  await expect(page.locator('[data-chat-grid-pane]')).toHaveCount(2)
  await expect(page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[2]}"])`)).toHaveCount(0)
  await context.close()
})

test('ten consecutive member moves have no geometry drift or stale overlay', async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page } = await openGridPage(browser, { reducedMotion: true, video: true })
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 4))

  const regions: DropRegion[] = ['left', 'right', 'top', 'between']
  for (let index = 0; index < 10; index += 1) {
    const sourceId = ids[index % 4]
    const targetId = ids[(index + 1) % 4]
    const region = regions[index % regions.length]
    const geometry = await dragSession(page, sourceId, targetId, region)
    expectGeometryMatch(geometry.preview, geometry.result, `repeat ${index + 1} ${region}`)
    await expectNoDropOverlay(page)
  }
  await page.screenshot({ path: artifactPath('pla-174-light-1440.png') })
  await context.close()
})

test('dark-theme cap drop matches its preview with token-only overlay styling', async ({ browser }) => {
  const { context, page } = await openGridPage(browser, { theme: 'dark', video: true })
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 4))

  const source = page.locator(`[data-chat-session-row="${ids[4]}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[1]}"])`)
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width * 0.875, targetBox!.y + targetBox!.height / 2, { steps: 16 })
  await page.waitForTimeout(100)
  await page.mouse.move(targetBox!.x + targetBox!.width * 0.875 + 0.5, targetBox!.y + targetBox!.height / 2 + 0.5)
  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toBeVisible()
  const previewBox = await overlay.boundingBox()
  expect(previewBox).not.toBeNull()
  const overlayStyle = await overlay.evaluate((element) => {
    const style = getComputedStyle(element)
    return { borderWidth: style.borderWidth, backgroundColor: style.backgroundColor }
  })
  expect(overlayStyle.borderWidth).toBe('0px')
  expect(overlayStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: artifactPath('pla-174-dark-1440-held.png') })
  await page.mouse.up()
  const droppedPane = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[4]}"])`)
  await expect(droppedPane).toHaveAttribute('data-grid-motion', 'idle')
  const resultBox = await droppedPane.boundingBox()
  expect(resultBox).not.toBeNull()
  expectGeometryMatch(rect(previewBox!), rect(resultBox!), 'dark cap eviction')
  await expectNoDropOverlay(page)
  await page.screenshot({ path: artifactPath('pla-174-dark-1440.png') })
  await context.close()
})

test('Open beside follows the view toggle and opens the picker in both themes', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) {
    const { context, page } = await openGridPage(browser, { theme })
    const [sessionId] = await seededSessionIds(page)
    await page.locator(`[data-chat-session-row="${sessionId}"]`).first().click()
    const more = page.locator('[data-more-menu]:visible').first()
    await more.getByRole('button', { name: 'More options' }).click()
    const buttons = more.getByRole('button')
    const labels = await buttons.allTextContents()
    const cliIndex = labels.findIndex((label) => label.trim() === 'CLI')
    const openIndex = labels.findIndex((label) => label.trim() === 'Open beside')
    const pinIndex = labels.findIndex((label) => label.trim() === 'Pin')
    expect(openIndex).toBe(cliIndex + 1)
    expect(openIndex).toBe(pinIndex - 1)
    await page.screenshot({ path: artifactPath(`pla-174-${theme}-menu-1440.png`) })
    await buttons.nth(openIndex).click()
    await expect(page.getByTestId('session-picker-scroll')).toBeVisible()
    await context.close()
  }
})
