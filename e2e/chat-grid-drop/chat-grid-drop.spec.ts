import path from 'node:path'
import { expect, test } from '@playwright/test'
import { cellRectForIndex } from '../../packages/web/src/routes/chat/grid-cells'
import {
  describeRect,
  dragSession,
  dragSessionToRightQuarter,
  expectGeometryMatch,
  expectNoDropOverlay,
  gatewayToken,
  rect,
  rectDelta,
  seededSessionIds,
  setWorkingSet,
  type DropRegion,
} from './chat-grid-drop.helpers'

test('real pointer preview matches the 2-to-3 pane right-region result', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900 },
    colorScheme: 'light',
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    recordVideo: { dir: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'videos'), size: { width: 1440, height: 900 } },
  })
  await context.addInitScript(() => {
    localStorage.setItem('jinn-theme', 'light')
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', 'true')
    localStorage.removeItem('jinn-chat-working-set')
  })
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'networkidle' })

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
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      colorScheme: 'light',
      extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    })
    await context.addInitScript(() => {
      localStorage.setItem('jinn-theme', 'light')
      localStorage.setItem('jinn-onboarded', 'true')
      localStorage.setItem('jinn-chat-list-open', 'true')
    })
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
    const ids = await seededSessionIds(page)

    const renderedCounts = viewport.width === 1440 ? [2, 3, 4] : [2, 3, 5]
    for (const count of renderedCounts) {
      const selected = ids.slice(0, count)
      await page.evaluate(({ sessionIds }) => {
        localStorage.setItem('jinn-chat-working-set', JSON.stringify({
          version: 1,
          sessionIds,
          focusedId: sessionIds[0],
          focusHistory: sessionIds,
        }))
      }, { sessionIds: selected })
      await page.reload({ waitUntil: 'networkidle' })
      await page.locator(`[data-chat-session-row="${selected[0]}"]`).first().click()

      const grid = page.getByTestId('chat-grid')
      const panes = grid.locator('[data-chat-grid-pane]')
      await expect(panes).toHaveCount(count)
      const gridBox = await grid.boundingBox()
      expect(gridBox).not.toBeNull()
      const spacing = await grid.evaluate((element) => (
        Number.parseFloat(getComputedStyle(element).getPropertyValue('--space-2'))
      ))

      for (let index = 0; index < count; index += 1) {
        await expect(panes.nth(index)).toHaveAttribute('data-grid-motion', 'idle')
        await expect(panes.nth(index)).toBeVisible()
        const actualBox = await panes.nth(index).boundingBox()
        expect(actualBox).not.toBeNull()
        const expected = cellRectForIndex(index, count, rect(gridBox!), {
          w: viewport.width,
          h: viewport.height,
        }, { padding: spacing, gap: spacing })
        const delta = rectDelta(expected, rect(actualBox!))
        for (const [axis, value] of Object.entries(delta)) {
          expect(Math.abs(value), `${count} panes, index ${index}, ${axis}`).toBeLessThanOrEqual(1)
        }
      }
    }
    await context.close()
  })

  test(`preview simulation matches pointer drops at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
    test.setTimeout(180_000)
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      colorScheme: 'light',
      extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    })
    await context.addInitScript(() => {
      localStorage.setItem('jinn-theme', 'light')
      localStorage.setItem('jinn-onboarded', 'true')
      localStorage.setItem('jinn-chat-list-open', 'true')
    })
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
    const ids = await seededSessionIds(page)
    const cases: Array<{ count: number; region: DropRegion; target: number }> = [
      { count: 2, region: 'left', target: 0 },
      { count: 2, region: 'right', target: 1 },
      { count: 2, region: 'between', target: 0 },
      { count: 3, region: 'top', target: 0 },
      { count: 3, region: 'bottom', target: 0 },
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

test('ten consecutive member moves have no geometry drift or stale overlay', async ({ browser }) => {
  test.setTimeout(180_000)
  const viewport = { width: 1440, height: 900 }
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    recordVideo: { dir: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'videos'), size: viewport },
  })
  await context.addInitScript(() => {
    localStorage.setItem('jinn-theme', 'light')
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', 'true')
  })
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'networkidle' })
  const ids = await seededSessionIds(page)
  await setWorkingSet(page, ids.slice(0, 4))

  const regions: DropRegion[] = ['left', 'right', 'top', 'bottom', 'between']
  for (let index = 0; index < 10; index += 1) {
    const sourceId = ids[index % 4]
    const targetId = ids[(index + 1) % 4]
    const region = regions[index % regions.length]
    const geometry = await dragSession(page, sourceId, targetId, region)
    expectGeometryMatch(geometry.preview, geometry.result, `repeat ${index + 1} ${region}`)
    await expectNoDropOverlay(page)
  }
  await page.screenshot({ path: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'pla-174-light-1440.png') })
  await context.close()
})

test('dark-theme cap drop matches its preview with token-only overlay styling', async ({ browser }) => {
  const viewport = { width: 1440, height: 900 }
  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: 'dark',
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    recordVideo: { dir: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'videos'), size: viewport },
  })
  await context.addInitScript(() => {
    localStorage.setItem('jinn-theme', 'dark')
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', 'true')
  })
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'networkidle' })
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
  await page.screenshot({ path: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'pla-174-dark-1440-held.png') })
  await page.mouse.up()
  const droppedPane = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${ids[4]}"])`)
  await expect(droppedPane).toHaveAttribute('data-grid-motion', 'idle')
  const resultBox = await droppedPane.boundingBox()
  expect(resultBox).not.toBeNull()
  expectGeometryMatch(rect(previewBox!), rect(resultBox!), 'dark cap eviction')
  await expectNoDropOverlay(page)
  await page.screenshot({ path: path.join(process.env.JINN_VERIFY_ARTIFACTS!, 'pla-174-dark-1440.png') })
  await context.close()
})

test('Open beside follows the view toggle and opens the picker in both themes', async ({ browser }) => {
  for (const theme of ['light', 'dark'] as const) {
    const viewport = { width: 1440, height: 900 }
    const context = await browser.newContext({
      viewport,
      screen: viewport,
      colorScheme: theme,
      extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    })
    await context.addInitScript((value) => {
      localStorage.setItem('jinn-theme', value)
      localStorage.setItem('jinn-onboarded', 'true')
      localStorage.setItem('jinn-chat-list-open', 'true')
    }, theme)
    const page = await context.newPage()
    await page.goto('/', { waitUntil: 'networkidle' })
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
    await page.screenshot({ path: path.join(process.env.JINN_VERIFY_ARTIFACTS!, `pla-174-${theme}-menu-1440.png`) })
    await buttons.nth(openIndex).click()
    await expect(page.getByTestId('session-picker-scroll')).toBeVisible()
    await context.close()
  }
})
