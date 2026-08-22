import path from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { gatewayToken } from './chat-grid-drop.helpers'

/**
 * Opening a grid page is its own concern, separate from the drag mechanics and geometry in
 * chat-grid-drop.helpers.ts. Every test in the suite needs the same authenticated context at a
 * fixed viewport with onboarding already dismissed and the chat list open, and each one used to
 * spell that out again — seven copies of the same fifteen lines, differing only in the viewport,
 * the theme, and whether the run records video. The differences are the arguments below.
 */

export type Theme = 'light' | 'dark'
export type Viewport = { width: number; height: number }

/** The viewport the drop-fidelity journey is specified against. */
export const DESKTOP: Viewport = { width: 1440, height: 900 }

export interface GridPageOptions {
  viewport?: Viewport
  theme?: Theme
  /** Record the drag as Todo evidence. Off by default: video costs wall-clock on every test. */
  video?: boolean
  /** Settle grid motion instantly, so a repeated-drag assertion is not racing an animation. */
  reducedMotion?: boolean
  /** Ignore a working set a previous test in the same sandbox persisted. */
  clearWorkingSet?: boolean
}

/** Where this run writes screenshots and video; the verify script creates it before Playwright starts. */
export function artifactPath(...segments: string[]): string {
  const artifacts = process.env.JINN_VERIFY_ARTIFACTS
  if (!artifacts) throw new Error('JINN_VERIFY_ARTIFACTS is required')
  return path.join(artifacts, ...segments)
}

export async function openGridPage(
  browser: Browser,
  options: GridPageOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = options.viewport ?? DESKTOP
  const theme = options.theme ?? 'light'
  const clearWorkingSet = options.clearWorkingSet ?? false

  const context = await browser.newContext({
    viewport,
    screen: viewport,
    colorScheme: theme,
    extraHTTPHeaders: { authorization: `Bearer ${gatewayToken()}` },
    ...(options.reducedMotion ? { reducedMotion: 'reduce' as const } : {}),
    ...(options.video ? { recordVideo: { dir: artifactPath('videos'), size: viewport } } : {}),
  })

  // The theme has to be in localStorage before the app's first paint, not just on the context:
  // colorScheme alone leaves the app rendering its own stored preference.
  await context.addInitScript((settings: { theme: Theme; clearWorkingSet: boolean }) => {
    localStorage.setItem('jinn-theme', settings.theme)
    localStorage.setItem('jinn-onboarded', 'true')
    localStorage.setItem('jinn-chat-list-open', 'true')
    if (settings.clearWorkingSet) localStorage.removeItem('jinn-chat-working-set')
  }, { theme, clearWorkingSet })

  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'networkidle' })
  return { context, page }
}
