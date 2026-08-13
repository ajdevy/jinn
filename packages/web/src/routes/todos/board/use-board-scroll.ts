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
 * rows and holds its place exactly. The grouped board does not, because at a
 * commit boundary it reports row positions its own settled layout contradicts:
 * on a 55-card board at 390x844 the anchored card was measured 5274px below
 * the scrollport while every card in the container measured 45px and the card
 * never left the DOM. A correction computed from that phantom throws the
 * reader — scrollTop 1400 landed at 54, 233 and 893 across runs, against the
 * 68px drift it was meant to remove. Deferring the correction a frame, taking
 * it only once it verifiably lands, holding the reader's own anchor across the
 * intermediate commits, giving the cards an accurate `contain-intrinsic-size`,
 * and dropping `content-visibility` altogether were each measured and each
 * left it. Until that container's commit-time layout can be trusted, it is
 * left to the browser; ICI-800's acceptance criterion 2 is not met here.
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
