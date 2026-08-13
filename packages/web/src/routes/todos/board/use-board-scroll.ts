import { useCallback, useEffect, useRef } from "react"
import type { NavigationType } from "react-router-dom"
import { useScrollAnchor } from "@/hooks/use-scroll-anchor"
import { recallBoardScroll, rememberBoardScroll } from "./board-route"

/**
 * Where the reader is on a board, in both directions: remembered per board and
 * put back on POP, and held steady across the reflow a status change causes.
 *
 * Anchoring is off while a card is lifted — the drag reorders the column under
 * the pointer, and correcting for that is fighting the reader, not helping.
 *
 * `attention` says which surface the board container is showing, and that
 * decides whether it can be anchored at all. The attention inbox renders plain
 * cards with a settled height. The grouped board renders `BoardCard`, which
 * carries `content-visibility: auto`: its height is an estimate the browser
 * revises as the reader travels, and on a 54-row board `scrollHeight` was
 * measured swinging between 2793px and 10069px across consecutive frames. A
 * correction measured at a commit boundary reads that swing as content moving
 * and chases it to an edge — reproduced three times, twice landing at
 * scrollTop 0. Until those cards report a real height, that container is left
 * to the browser.
 */
export function useBoardScroll(
  key: string,
  navigationType: NavigationType,
  { dragging, attention }: { dragging: boolean; attention: boolean },
) {
  const boardScrollRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const reanchorBoard = useScrollAnchor(boardScrollRef, !dragging && attention)
  const reanchorList = useScrollAnchor(listScrollRef, !dragging)

  const onBoardScroll = useCallback(() => {
    const el = boardScrollRef.current
    if (el) rememberBoardScroll(key, el.scrollTop)
    reanchorBoard()
  }, [key, reanchorBoard])
  const onListScroll = useCallback(() => {
    const el = listScrollRef.current
    if (el) rememberBoardScroll(key, el.scrollTop)
    reanchorList()
  }, [key, reanchorList])

  useEffect(() => {
    const scrollTop = navigationType === "POP" ? recallBoardScroll(key) : 0
    if (boardScrollRef.current) boardScrollRef.current.scrollTop = scrollTop
    if (listScrollRef.current) listScrollRef.current.scrollTop = scrollTop
  }, [key, navigationType])

  return { boardScrollRef, listScrollRef, onBoardScroll, onListScroll }
}
