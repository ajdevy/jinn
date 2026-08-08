import type { WorkItemCommentPageWire, WorkItemCommentWire } from "@/lib/api"

/* The Todo detail payload embeds the LAST comments of the thread; the comments
 * route serves from the START. So the page never has to re-request the tail it
 * was already handed — it asks for the window in front of it and unions the
 * two. Pure, so both halves of that arithmetic are testable on their own. */

/** The gateway clamps one comment page to 500 rows (COMMENT_PAGE_MAX_LIMIT). */
const PAGE_MAX = 500

/** The window of comments the embedded tail does not already carry: the tail is
 *  the last `n` of `total`, so what is missing is exactly `[0, total - n)`.
 *  `null` means the tail is the whole thread and there is nothing left to ask
 *  for. A gateway too old to embed a tail gets the whole first page, as before. */
export function commentHeadRequest(
  tail: WorkItemCommentPageWire | undefined,
): { limit: number; offset: number } | null {
  if (!tail) return { limit: PAGE_MAX, offset: 0 }
  const missing = tail.total - tail.comments.length
  return missing > 0 ? { limit: Math.min(PAGE_MAX, missing), offset: 0 } : null
}

/** Head window then embedded tail as one chronological list, each comment once.
 *  The windows overlap when a comment lands between the two requests — rows
 *  shift, ids do not — so the first sighting of an id keeps its place. */
export function mergeCommentPages(
  head: WorkItemCommentPageWire | undefined,
  tail: WorkItemCommentPageWire | undefined,
): WorkItemCommentWire[] {
  const comments: WorkItemCommentWire[] = []
  const seen = new Set<string>()
  for (const comment of [...(head?.comments ?? []), ...(tail?.comments ?? [])]) {
    if (seen.has(comment.id)) continue
    seen.add(comment.id)
    comments.push(comment)
  }
  return comments
}
