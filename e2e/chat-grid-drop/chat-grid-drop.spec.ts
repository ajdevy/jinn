import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { cellRectForIndex } from '../../packages/web/src/routes/chat/grid-cells'

type Rect = { left: number; top: number; width: number; height: number }

const home = process.env.JINN_VERIFY_HOME
const baseUrl = process.env.JINN_VERIFY_BASE_URL

if (!home || !baseUrl) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_BASE_URL are required')

function gatewayToken(): string {
  const gateway = JSON.parse(fs.readFileSync(path.join(home!, 'gateway.json'), 'utf8')) as { token?: unknown }
  if (typeof gateway.token !== 'string' || !gateway.token) throw new Error('sandbox gateway token is missing')
  return gateway.token
}

function rect(box: { x: number; y: number; width: number; height: number }): Rect {
  return { left: box.x, top: box.y, width: box.width, height: box.height }
}

function rectDelta(preview: Rect, result: Rect) {
  return {
    left: result.left - preview.left,
    top: result.top - preview.top,
    width: result.width - preview.width,
    height: result.height - preview.height,
  }
}

function describeRect(value: Rect): string {
  return `${value.width.toFixed(1)}x${value.height.toFixed(1)} @ (${value.left.toFixed(1)},${value.top.toFixed(1)})`
}

async function seededSessionIds(page: Page): Promise<string[]> {
  const sessionsResponse = await page.request.get('/api/sessions')
  expect(sessionsResponse.ok()).toBe(true)
  const payload = await sessionsResponse.json() as { sessions?: Array<{ id?: unknown; title?: unknown }> } | Array<{ id?: unknown; title?: unknown }>
  const sessions = Array.isArray(payload) ? payload : payload.sessions ?? []
  return [
    '#1 - Chat layout QA',
    '#2 - Delegation flow',
    '#3 - Design pass',
    '#4 - Release notes',
    '#5 - Incident review',
  ].map((title) => {
    const entry = sessions.find((session) => typeof session.title === 'string' && session.title.includes(title))
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`missing seeded session: ${title}`)
    return entry.id
  })
}

async function dragSessionToRightQuarter(page: Page, sessionId: string, targetPaneId: string) {
  const source = page.locator(`[data-chat-session-row="${sessionId}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${targetPaneId}"])`)
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()

  const from = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 }
  const to = { x: targetBox!.x + targetBox!.width * 0.875, y: targetBox!.y + targetBox!.height / 2 }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 16 })

  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toBeVisible()
  await expect(overlay).toHaveAttribute('data-drop-region', 'right')
  const previewBox = await overlay.boundingBox()
  expect(previewBox).not.toBeNull()

  await page.mouse.up()
  const droppedPane = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${sessionId}"])`)
  await expect(droppedPane).toBeVisible()
  await expect(droppedPane).toHaveAttribute('data-grid-motion', 'idle')
  await page.waitForTimeout(300)
  const resultBox = await droppedPane.boundingBox()
  expect(resultBox).not.toBeNull()
  return { preview: rect(previewBox!), result: rect(resultBox!) }
}

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
}
