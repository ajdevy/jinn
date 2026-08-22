import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

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

  const sessionsResponse = await page.request.get('/api/sessions')
  expect(sessionsResponse.ok()).toBe(true)
  const sessionsPayload = await sessionsResponse.json() as { sessions?: Array<{ id?: unknown; title?: unknown }> } | Array<{ id?: unknown; title?: unknown }>
  const seeded = Array.isArray(sessionsPayload) ? sessionsPayload : sessionsPayload.sessions ?? []
  const idFor = (title: string) => {
    const entry = seeded.find((session) => typeof session.title === 'string' && session.title.includes(title))
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`missing seeded session: ${title}`)
    return entry.id
  }
  const sessionA = idFor('#1 - Chat layout QA')
  const sessionB = idFor('#2 - Delegation flow')
  const sessionC = idFor('#3 - Design pass')

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
