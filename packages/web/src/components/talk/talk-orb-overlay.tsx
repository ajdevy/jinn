import { Suspense, lazy } from "react"
import { useSettings } from "@/routes/settings-provider"
import { useTalkSessionId } from "./talk-session-store"

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
  // Null until a browser transport opens one, which is the whole of what the
  // action log's gateway copy is waiting on.
  const sessionId = useTalkSessionId()
  if (!settings.talkOrb) return null
  return (
    <Suspense fallback={null}>
      <TalkSurface sessionId={sessionId} />
    </Suspense>
  )
}
