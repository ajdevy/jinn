/** `Not delivered · Retry`, right-aligned under the bubble that failed. The
 *  label is far under the coarse-pointer target, so `.send-retry-btn` carries
 *  the padding that reaches it. `reason` is the transport error, kept out of the
 *  copy but reachable rather than discarded. */
export function SendFailureRow({ reason, onRetry }: { reason?: string; onRetry?: () => void }) {
  return (
    <div className="send-failure-row mt-0.5 flex items-center gap-1 px-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]" title={reason}>
      <span>Not delivered</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={onRetry} disabled={!onRetry} className="send-retry-btn inline-flex items-center justify-center border-none bg-transparent px-1 text-[var(--system-red)] cursor-pointer disabled:cursor-default disabled:opacity-40">Retry</button>
    </div>
  )
}
