/**
 * The host for the `routes` area: a page a plugin contributes, rendered at a
 * path of its own.
 *
 * It is mounted as the router's LAST child, on the splat path, which is what
 * makes shadowing structurally impossible: React Router matches every static
 * child first, so a contribution can only ever be reached at a path the app
 * itself does not claim. The reserved-segment check below is the same rule said
 * a second time, in the one place that can say WHY a contribution never renders
 * instead of leaving its author to guess.
 */
import { useSyncExternalStore } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PageLayout } from '@/components/page-layout'
import { ContribBoundary } from '@/contrib/boundary'
import { ContributionOutlet } from '@/contrib/slot'
import { AREAS, type ResolvedContribution } from '@/contrib/types'
import { useContributions } from '@/contrib/use-contributions'
import { diskPluginsSettled, subscribeDiskPluginsSettled } from '@/plugins/disk-plugins'

/** What a `routes` contribution declares. The element itself comes from
 *  `render()`, like every other UI contribution. */
export interface RouteContributionData {
  /** One absolute path segment, e.g. `/inbox-demo`. */
  path: string
}

/** The first segment of a router path, which is the unit a contributed page
 *  competes for: `/notes/*` and `/todos/:todoId` both claim their whole subtree. */
export function firstSegment(routePath: string): string {
  return `/${routePath.replace(/^\//, '').split('/')[0] ?? ''}`
}

/** The segments the app's own routes claim, from the router's children rather
 *  than from a second list that could drift from them. */
export function reservedSegments(routePaths: readonly (string | undefined)[]): Set<string> {
  return new Set(routePaths.filter((path): path is string => !!path).map(firstSegment))
}

/** Ids already reported, so a rejected contribution is explained once rather
 *  than on every navigation. */
const explained = new Set<string>()

function reject(contribution: ResolvedContribution, problem: string): null {
  const key = `${contribution.source}:${contribution.id}`
  if (!explained.has(key)) {
    explained.add(key)
    console.warn(`[contrib:${contribution.id}] ${problem}`)
  }
  return null
}

/** The path a contribution may be rendered at, or null with the reason logged. */
function claimedPath(contribution: ResolvedContribution, reserved: ReadonlySet<string>): string | null {
  const path = (contribution.data as Partial<RouteContributionData> | undefined)?.path
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return reject(contribution, 'a routes contribution needs data.path as an absolute path')
  }
  if (path.slice(1).includes('/') || path.includes(':') || path.includes('*')) {
    return reject(contribution, `path "${path}" must be one plain segment, without nested segments or parameters`)
  }
  if (typeof contribution.render !== 'function') {
    return reject(contribution, `path "${path}" has no render(), so there is nothing to show there`)
  }
  if (reserved.has(firstSegment(path))) {
    return reject(contribution, `path "${path}" is one of the app's own routes and will not be served`)
  }
  return path
}

/** The contribution that owns `pathname`, or null when none does. Ties go to the
 *  first registered, so a second plugin claiming a taken path cannot displace it. */
export function contributedRouteFor(
  pathname: string,
  candidates: readonly ResolvedContribution[],
  reserved: ReadonlySet<string>,
): ResolvedContribution | null {
  return candidates.find((contribution) => claimedPath(contribution, reserved) === pathname) ?? null
}

/**
 * The splat route. A plugin's page when one claims this path, and otherwise the
 * app's answer to a URL nobody owns — the same redirect `/chat` gives, rather
 * than the router's bare error screen.
 *
 * Nothing is decided until the plugins have been looked for: a bookmarked
 * plugin page is rendered before the first scan has run, and redirecting in that
 * window would bounce every one of them to chat.
 */
export function ContributedRoute({ reserved }: { reserved: ReadonlySet<string> }) {
  const pathname = useLocation().pathname
  const settled = useSyncExternalStore(subscribeDiskPluginsSettled, diskPluginsSettled, () => true)
  const contribution = contributedRouteFor(pathname, useContributions(AREAS.routes), reserved)
  if (!contribution) return settled ? <Navigate to="/" replace /> : null

  // The app's chrome and the scroll container come from the host, not from the
  // plugin. `PageLayout` is not on the SDK's export list, so a contributed page
  // that had to supply its own would be a page with no way back to the rest of
  // the app.
  return (
    <PageLayout>
      <div className="h-full overflow-y-auto" data-scrollable>
        <ContribBoundary id={contribution.id} variant="pane">
          <ContributionOutlet contribution={contribution} />
        </ContribBoundary>
      </div>
    </PageLayout>
  )
}
