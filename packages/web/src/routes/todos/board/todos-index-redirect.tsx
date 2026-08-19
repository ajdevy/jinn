import { Navigate, redirect, useLocation, type LoaderFunctionArgs } from "react-router-dom"
import { DEFAULT_BOARD_PATH } from "./board-route"

/** Where a legacy /todos URL lands now that the board is the front door.
 *  Old deep links keep meaning what they meant: the needs-you lens maps to the
 *  Attention board; the people lens (retired with the legacy list at the
 *  stage-C cutover, superseded by department boards) lands on Everything —
 *  the whole-org view is its closest surviving meaning. Remaining search
 *  params ride along so filtered bookmarks stay filtered. Pure — unit-tested
 *  directly. */
export function legacyTodosRedirectTarget(search: string): string {
  const params = new URLSearchParams(search)
  const view = params.get("view")
  params.delete("view")
  const rest = params.toString()
  const suffix = rest ? `?${rest}` : ""
  if (view === "needs") return `/todos/b/attention${suffix}`
  if (view === "people") return `/todos/b/everything${suffix}`
  return `${DEFAULT_BOARD_PATH}${suffix}`
}

/** Router-level redirect for /todos (and legacy /kanban): resolved during the
 *  navigation, BEFORE anything commits. An element-level <Navigate> renders
 *  null for a full commit, which unmounts the old page into an EMPTY root for
 *  a painted frame — on mobile the tab bar and page visibly flashed out on
 *  every chat → todos tap (and a view transition animates to that empty frame,
 *  stretching the flash to its full duration). A loader redirect produces one
 *  commit: old page → board. */
export function todosIndexLoader({ request }: LoaderFunctionArgs) {
  return redirect(legacyTodosRedirectTarget(new URL(request.url).search))
}

/** Route element for the /todos index: redirect into the board surface.
 *  Unreachable while todosIndexLoader is wired (the loader always redirects);
 *  kept as the belt-and-braces fallback. */
export function TodosIndexRedirect() {
  const location = useLocation()
  return <Navigate to={legacyTodosRedirectTarget(location.search)} replace />
}
