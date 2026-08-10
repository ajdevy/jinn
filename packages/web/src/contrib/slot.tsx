import { ContribBoundary, type ContribBoundaryVariant } from "./boundary"
import { useContributions } from "./use-contributions"
import type { ResolvedContribution } from "./types"

interface SlotProps {
  /** Area id whose contributions render here, in order. */
  area: string
  /** Fallback shape for a contribution that throws. */
  variant?: ContribBoundaryVariant
}

/**
 * Calling `render()` from here rather than from {@link Slot} is the whole point
 * of this component. As a child element it runs during its OWN render pass,
 * which is inside the boundary. Called in the parent's pass — as the child
 * expression `{contribution.render?.()}` — a synchronous throw happens before
 * the boundary exists to catch it, and takes the entire slot down with it.
 */
function ContributionOutlet({ contribution }: { contribution: ResolvedContribution }) {
  return <>{contribution.render?.()}</>
}

/** Renders one area's contributions, each inside its own error boundary. */
export function Slot({ area, variant = "pane" }: SlotProps) {
  const items = useContributions(area)
  if (items.length === 0) return null

  return (
    <>
      {items.map((contribution) => (
        <ContribBoundary
          key={`${contribution.source}:${contribution.id}`}
          id={contribution.id}
          variant={variant}
        >
          <ContributionOutlet contribution={contribution} />
        </ContribBoundary>
      ))}
    </>
  )
}
