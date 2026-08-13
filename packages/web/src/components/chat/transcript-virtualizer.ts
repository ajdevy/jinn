import { useCallback, useRef } from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import type { MessageItem, RenderGroup } from './chat-messages'
import { restoreVisibleAnchor, type ScrollAnchor } from './scroll-anchor'

/**
 * Windowing for the chat transcript.
 *
 * The virtual row is a `RenderGroup`, not a message: the transcript renders
 * through fold regions, and a fold owns one animating height for the whole run
 * of evidence inside it. Virtualising its children would fight that animation,
 * so a fold is ONE item — and one item is all it costs, because a windowed
 * transcript tells a FOLDED region to drop its evidence rather than mount it.
 * That matters more than the windowing itself on a long single turn: a whole
 * turn of work is one group, so the window alone would still mount every row.
 *
 * Two things the sidebar's virtual list gets away with and this one cannot:
 *  · `getItemKey` must be a stable group id. Prepending an older page shifts
 *    every index, and an index-keyed measurement cache would then describe the
 *    wrong rows — anchoring lands wrong and the reader jumps.
 *  · Anchoring after that prepend must go through the virtualizer's own offsets.
 *    The anchored row is 100 rows above the window by then, so it is unmounted
 *    and has no rect to measure.
 *
 * The transcript's header padding is deliberately NOT declared as `scrollMargin`:
 * it shifts the visible range by ~80px, which the overscan band already covers,
 * and every offset this module compares is a difference between two of the
 * virtualizer's own numbers, where the shift cancels.
 */

/** Below this many rows the transcript renders every one of them, as it always has. */
export const VIRTUALIZE_THRESHOLD = 50

/** Rows kept mounted beyond the visible window, each side. */
const OVERSCAN = 8

/** Resting heights, in px. Wrong is fine — every mounted row re-measures. */
const PLAIN_MESSAGE_SIZE = 140
const TOOL_ROW_SIZE = 56
const DISPATCH_ROW_SIZE = 44
const BURST_SIZE = 72
/** A fold rests closed: its summary line plus the inset above it. */
const FOLDED_REGION_SIZE = 56

function estimateItemSize(item: MessageItem): number {
  switch (item.kind) {
    case 'tool-group': return TOOL_ROW_SIZE
    case 'dispatch-call': return DISPATCH_ROW_SIZE
    case 'callback-burst':
    case 'todo-burst': return BURST_SIZE
    default: return PLAIN_MESSAGE_SIZE
  }
}

export function estimateGroupSize(group: RenderGroup): number {
  return group.kind === 'fold' ? FOLDED_REGION_SIZE : estimateItemSize(group.item)
}

function itemKey(item: MessageItem): string {
  switch (item.kind) {
    case 'message':
    case 'dispatch-call': return item.msg.id || `i${item.index}`
    case 'callback-burst': return item.entries[0].msg.id || `i${item.startIndex}`
    default: return item.msgs[0].id || `i${item.startIndex}`
  }
}

/** Stable across prepends, appends and streaming — never derived from the index. */
export function groupKey(group: RenderGroup): string {
  return group.kind === 'fold' ? `fold-${group.id}` : `plain-${itemKey(group.item)}`
}

export type TranscriptVirtualizer = Virtualizer<HTMLDivElement, Element>

export function useTranscriptVirtualizer(
  groups: RenderGroup[],
  keys: string[],
  enabled: boolean,
  getScrollElement: () => HTMLDivElement | null,
): TranscriptVirtualizer {
  // Read through a ref: the key extractor's identity invalidates the whole
  // measurement pass, and a fresh closure per render would rebuild it on every
  // streaming token.
  const keysRef = useRef(keys)
  keysRef.current = keys
  return useVirtualizer({
    count: enabled ? groups.length : 0,
    enabled,
    getScrollElement,
    estimateSize: (index) => estimateGroupSize(groups[index]),
    getItemKey: useCallback((index: number) => keysRef.current[index], []),
    overscan: OVERSCAN,
  })
}

/**
 * Where the reader is, expressed in the virtualizer's coordinates.
 *
 * `start` is the anchored group's own offset. Restoring compares it against the
 * same group's offset after the prepend, so the answer is exact even though the
 * inserted rows are still estimates: what a row's estimate decides is where the
 * row gets painted, and both readings come from that same bookkeeping.
 */
export interface VirtualAnchor {
  key: string
  start: number
  /** Set once the coarse scroll has run, so it runs exactly once per page. */
  coarseApplied?: boolean
}

/** Anchor on the topmost mounted group still intersecting the scrollport. */
export function captureVirtualAnchor(
  node: HTMLDivElement,
  virtualizer: TranscriptVirtualizer,
  keys: string[],
): VirtualAnchor | null {
  const containerTop = node.getBoundingClientRect().top
  for (const row of node.querySelectorAll<HTMLElement>('[data-index]')) {
    if (row.getBoundingClientRect().bottom < containerTop) continue
    const index = Number(row.dataset.index)
    const key = keys[index]
    const start = virtualizer.getOffsetForIndex(index, 'start')?.[0]
    return key !== undefined && start !== undefined ? { key, start } : null
  }
  return null
}

/**
 * Bring the anchored group back into the window. Coarse on purpose: the rows
 * that land in the window on the way there resolve their real heights as they
 * mount, which moves everything below them again — `alignAnchoredRow` is the
 * pass that settles it, off the row's own rect. Returns false when the group no
 * longer exists (regrouping can dissolve one) so the caller can fall back.
 */
export function restoreVirtualAnchor(
  node: HTMLDivElement,
  virtualizer: TranscriptVirtualizer,
  keys: string[],
  anchor: VirtualAnchor,
): boolean {
  const index = keys.indexOf(anchor.key)
  if (index < 0) return false
  const start = virtualizer.getOffsetForIndex(index, 'start')?.[0]
  if (start === undefined) return false
  // Through the virtualizer rather than straight onto `scrollTop`: it has to
  // know the position moved, or the window it renders stays the one it worked
  // out for the old offset and the reader lands among the rows just inserted.
  virtualizer.scrollToOffset(node.scrollTop + (start - anchor.start))
  return true
}

/**
 * Put the anchored message back under the same pixel, measured from the row
 * itself. Returns false while that row is still outside the window, so the
 * caller can wait for the commit that mounts it.
 */
function alignAnchoredRow(
  node: HTMLDivElement,
  virtualizer: TranscriptVirtualizer,
  messageId: string,
  offset: number,
): boolean {
  const target = node.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
  if (!target) return false
  const drift = target.getBoundingClientRect().top - node.getBoundingClientRect().top - offset
  if (Math.abs(drift) > 0.5) virtualizer.scrollToOffset(node.scrollTop + drift)
  return true
}

export interface AnchorRestore {
  node: HTMLDivElement
  virtualizer: TranscriptVirtualizer
  keys: string[]
  /** Read position measured from the DOM, as the plain path has always taken it. */
  anchor: ScrollAnchor
  /** Its counterpart in virtualizer coordinates, absent on the plain path. */
  virtual: VirtualAnchor | null
}

/**
 * Put the reader back after a prepend, and say whether the anchor is spent.
 *
 * Windowed, it takes two commits: the coarse scroll brings the anchored row back
 * into the window, then the row's own rect settles it exactly — the rows that
 * enter the window on the way there resolve their real heights as they arrive,
 * which moves everything below them again. Returning false in between is what
 * stops the measured-rect fallback from correcting a second time on top of it.
 */
export function applyTranscriptAnchor({ node, virtualizer, keys, anchor, virtual }: AnchorRestore): boolean {
  if (virtual && !virtual.coarseApplied) {
    virtual.coarseApplied = true
    if (restoreVirtualAnchor(node, virtualizer, keys, virtual)) return false
    // The group is gone — regrouping can dissolve one — so fall through to the
    // reading that does not depend on it.
    virtual.key = ''
  }
  if (virtual?.coarseApplied && virtual.key) {
    if (!anchor.id) return true
    return alignAnchoredRow(node, virtualizer, anchor.id, anchor.offset)
  }
  restoreVisibleAnchor(node, anchor)
  return true
}
