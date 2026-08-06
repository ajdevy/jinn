import { Suspense, lazy } from "react"
import { useSettings } from "@/routes/settings-provider"

/** Lazy, because the initial critical path has a budget and the orb is off for
 *  everyone who has not asked for it. */
const TalkOrb = lazy(() => import("./talk-orb").then((module) => ({ default: module.TalkOrb })))

/**
 * Mounted once above the router so the orb survives every route change. Renders
 * nothing — and fetches nothing — until the Talk Orb setting is on.
 */
export function TalkOrbOverlay() {
  const { settings } = useSettings()
  if (!settings.talkOrb) return null
  return (
    <Suspense fallback={null}>
      <TalkOrb />
    </Suspense>
  )
}
