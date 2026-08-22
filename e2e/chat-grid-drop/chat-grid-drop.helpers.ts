import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'

export type Rect = { left: number; top: number; width: number; height: number }
export type DropRegion = 'left' | 'right' | 'top' | 'bottom' | 'between' | 'end'

const home = process.env.JINN_VERIFY_HOME
const baseUrl = process.env.JINN_VERIFY_BASE_URL

if (!home || !baseUrl) throw new Error('JINN_VERIFY_HOME and JINN_VERIFY_BASE_URL are required')

export function gatewayToken(): string {
  const gateway = JSON.parse(fs.readFileSync(path.join(home!, 'gateway.json'), 'utf8')) as { token?: unknown }
  if (typeof gateway.token !== 'string' || !gateway.token) throw new Error('sandbox gateway token is missing')
  return gateway.token
}

export function rect(box: { x: number; y: number; width: number; height: number }): Rect {
  return { left: box.x, top: box.y, width: box.width, height: box.height }
}

export function rectDelta(preview: Rect, result: Rect) {
  return {
    left: result.left - preview.left,
    top: result.top - preview.top,
    width: result.width - preview.width,
    height: result.height - preview.height,
  }
}

export function describeRect(value: Rect): string {
  return `${value.width.toFixed(1)}x${value.height.toFixed(1)} @ (${value.left.toFixed(1)},${value.top.toFixed(1)})`
}

export async function seededSessionIds(page: Page): Promise<string[]> {
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
    '#6 - Accessibility pass',
  ].map((title) => {
    const entry = sessions.find((session) => typeof session.title === 'string' && session.title.includes(title))
    if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`missing seeded session: ${title}`)
    return entry.id
  })
}

export async function dragSessionToRightQuarter(page: Page, sessionId: string, targetPaneId: string) {
  return dragSession(page, sessionId, targetPaneId, 'right')
}

function dropPoint(
  region: DropRegion,
  target: { x: number; y: number; width: number; height: number },
  grid: { x: number; y: number; width: number; height: number },
) {
  if (region === 'end') return { x: grid.x + grid.width * 0.75, y: grid.y + grid.height * 0.75 }
  const fractions: Record<Exclude<DropRegion, 'between' | 'end'>, { x: number; y: number }> = {
    left: { x: 0.125, y: 0.5 },
    right: { x: 0.875, y: 0.5 },
    top: { x: 0.5, y: 0.125 },
    bottom: { x: 0.5, y: 0.875 },
  }
  const fraction = region === 'between' ? fractions.right : fractions[region]
  return { x: target.x + target.width * fraction.x, y: target.y + target.height * fraction.y }
}

export async function dragSession(
  page: Page,
  sessionId: string,
  targetPaneId: string,
  region: DropRegion,
  expectedIndex?: number,
) {
  const source = page.locator(`[data-chat-session-row="${sessionId}"]`).first()
  const target = page.locator(`[data-chat-grid-pane]:has([data-chat-pane-session="${targetPaneId}"])`)
  const grid = page.getByTestId('chat-grid')
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  const gridBox = await grid.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  expect(gridBox).not.toBeNull()

  const from = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 }
  const to = dropPoint(region, targetBox!, gridBox!)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 16 })
  await page.waitForTimeout(100)
  await page.mouse.move(to.x + 0.5, to.y + 0.5, { steps: 2 })

  const overlay = page.getByTestId('chat-grid-drop-zone')
  await expect(overlay).toBeVisible()
  await page.waitForTimeout(300)
  await expect(overlay).toHaveAttribute('data-drop-region', region === 'between' ? 'right' : region)
  if (expectedIndex !== undefined) await expect(overlay).toHaveAttribute('data-drop-index', String(expectedIndex))
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

export async function setWorkingSet(page: Page, sessionIds: string[]): Promise<void> {
  await page.evaluate(({ ids }) => {
    localStorage.setItem('jinn-chat-working-set', JSON.stringify({
      version: 1,
      sessionIds: ids,
      focusedId: ids[0],
      focusHistory: ids,
    }))
  }, { ids: sessionIds })
  await page.goto(`/?session=${sessionIds[0]}`, { waitUntil: 'networkidle' })
  const panes = page.locator('[data-chat-grid-pane]')
  await expect(panes).toHaveCount(sessionIds.length)
  for (let index = 0; index < sessionIds.length; index += 1) {
    await expect(panes.nth(index)).toHaveAttribute('data-grid-motion', 'idle')
  }
  await page.waitForTimeout(100)
}

export async function expectNoDropOverlay(page: Page): Promise<void> {
  await expect(page.getByTestId('chat-grid-drop-zone')).toHaveCount(0)
}

export function expectGeometryMatch(preview: Rect, result: Rect, label: string): void {
  const delta = rectDelta(preview, result)
  for (const [axis, value] of Object.entries(delta)) {
    expect(Math.abs(value), `${label}; ${axis} delta ${value}`).toBeLessThanOrEqual(1)
  }
}
