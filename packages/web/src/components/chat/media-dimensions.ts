/**
 * What shape a picture turned out to be, kept for the rest of the tab's life.
 *
 * A thumbnail can only reserve the right height if its ratio is known before the
 * bytes arrive, and the only place that ratio exists is a decode that already
 * happened. Scrolling back through a transcript, or reopening it, is the common
 * case — so remembering per url is what turns the reserved box from a guess into
 * the real thing on every view after the first.
 */

/** What a picture is assumed to be until one has actually been measured. */
export const FALLBACK_RATIO = 4 / 3

const ratios = new Map<string, number>()

/**
 * A decoded image reports 0x0 while it is broken or still empty, and dividing
 * those gives NaN — a ratio that would collapse every box it sized. Only a real
 * pair of sides is worth dividing.
 */
function toRatio(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return width / height
}

export function rememberRatio(url: string, width: number, height: number): void {
  const ratio = toRatio(width, height)
  if (ratio !== null) ratios.set(url, ratio)
}

/**
 * The shape the server measured off the bytes, when the payload carries it.
 * This is the only ratio available on the very first view of a picture, and the
 * only one that is right for every picture — a guessed one is wrong for some.
 */
export function declaredRatio(width?: number, height?: number): number | null {
  if (width === undefined || height === undefined) return null
  return toRatio(width, height)
}

export function knownRatio(url: string): number | null {
  return ratios.get(url) ?? null
}
