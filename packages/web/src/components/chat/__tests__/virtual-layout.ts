import {
  installVirtualLayout as install,
  type VirtualLayout as SharedVirtualLayout,
} from '@/test/virtual-layout'

/**
 * The transcript's targets. The engine lives in `@/test/virtual-layout` so any
 * virtualised surface can drive it; this binding pins it to the transcript's
 * DOM and keeps the transcript tests speaking in messages, not rows.
 */
const TRANSCRIPT = {
  scroller: '.chat-messages-scroll',
  row: '[data-message-id]',
  rowId: 'data-message-id',
}

export interface VirtualLayout extends Omit<SharedVirtualLayout, 'mountedRowIds' | 'visibleRowIds'> {
  /** Mounted `[data-message-id]` rows, in DOM order. */
  mountedMessageIds: () => string[]
  /** Those of them the reader can actually see. */
  visibleMessageIds: () => string[]
}

export function installVirtualLayout(rowHeight: number, viewportHeight: number): VirtualLayout {
  const { mountedRowIds, visibleRowIds, ...layout } = install(rowHeight, viewportHeight, TRANSCRIPT)
  return { ...layout, mountedMessageIds: mountedRowIds, visibleMessageIds: visibleRowIds }
}
