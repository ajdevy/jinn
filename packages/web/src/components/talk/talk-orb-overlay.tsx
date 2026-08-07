import { Suspense, lazy } from "react"
import { useSettings } from "@/routes/settings-provider"

/** Lazy, because the initial critical path has a budget and the surface is off
 *  for everyone who has not asked for it. */
const TalkSurface = lazy(() =>
  import("./talk-surface").then((module) => ({ default: module.TalkSurface })),
)

/**
 * Mounted once above the router so the orb survives every route change. Renders
 * nothing — and fetches nothing — until the Talk Orb setting is on.
 */
export function TalkOrbOverlay() {
  const { settings } = useSettings()
  if (!settings.talkOrb) return null
  return (
    <Suspense fallback={null}>
      <TalkSurface />
    </Suspense>
  )
}
