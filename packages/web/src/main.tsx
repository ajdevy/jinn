import { Component, Suspense, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, Outlet, RouterProvider, createBrowserRouter, type RouteObject } from 'react-router-dom'
import { ClientProviders } from './routes/client-providers'
import { ContributedRoute, reservedSegments } from './routes/contributed-route'
import { registerTalkNavigator } from './components/talk/tools/router-handle'
import { registerHostNavigator } from './plugins/sdk/host-bridge'
import { lazyRoute } from './lib/lazy-route'
import { registerRoutePrefetch } from './lib/route-prefetch'
import { startKeyboardInset } from './lib/native/keyboard-inset'
import { useRouteLoadingPresence } from './components/chat/chat-hydration'
import { TodosIndexRedirect } from './routes/todos/board/todos-index-redirect'
import { useFeatures } from './hooks/use-features'
import { APP_ROUTES, type AppRouteId } from './lib/app-routes'
import './routes/globals.css'

const ChatPage = lazyRoute(() => import('./routes/chat/page'), 'chat')
const CronPage = lazyRoute(() => import('./routes/cron/page'), 'cron')
const CronDetailPage = lazyRoute(() => import('./routes/cron/detail'), 'cron-detail')
const TodoBoardPage = lazyRoute(() => import('./routes/todos/board/board-page'), 'todo-board')
const TaskPage = lazyRoute(() => import('./routes/todos/task-page/task-page'), 'todo-task')
const NotesPage = lazyRoute(() => import('./routes/notes/page'), 'notes')
const ExperimentsPage = lazyRoute(() => import('./routes/experiments/page'), 'experiments')
const ExperimentDetailPage = lazyRoute(() => import('./routes/experiments/detail'), 'experiment-detail')
const LogsPage = lazyRoute(() => import('./routes/logs/page'), 'logs')
const LimitsPage = lazyRoute(() => import('./routes/limits/page'), 'limits')
const OrgPage = lazyRoute(() => import('./routes/org/page'), 'org')
const SettingsPage = lazyRoute(() => import('./routes/settings/page'), 'settings')
const PluginsSettingsPage = lazyRoute(() => import('./routes/settings/plugins/page'), 'settings-plugins')
const SkillsPage = lazyRoute(() => import('./routes/skills/page'), 'skills')
const SkillDetailPage = lazyRoute(() => import('./routes/skills/detail'), 'skill-detail')
const FilePage = lazyRoute(() => import('./routes/file/page'), 'file')
const MorePage = lazyRoute(() => import('./routes/more/page'), 'more')
const RedesignPage = lazyRoute(() => import('./routes/redesign/page'), 'redesign')
const TalkOrbHarnessPage = lazyRoute(() => import('./routes/talk-orb-harness/page'), 'talk-orb-harness')
const WorkflowListPage = lazyRoute(() => import('./routes/workflow/list'), 'workflow-list')
const WorkflowPage = lazyRoute(() => import('./routes/workflow/page'), 'workflow')
const WorkflowRunPage = lazyRoute(() => import('./routes/workflow/run'), 'workflow-run')

registerRoutePrefetch('/', ChatPage.prefetch)
registerRoutePrefetch('/cron', CronPage.prefetch)
registerRoutePrefetch('/todos', TodoBoardPage.prefetch)
registerRoutePrefetch('/notes', NotesPage.prefetch)
registerRoutePrefetch('/experiments', ExperimentsPage.prefetch)
registerRoutePrefetch('/logs', LogsPage.prefetch)
registerRoutePrefetch('/limits', LimitsPage.prefetch)
registerRoutePrefetch('/org', OrgPage.prefetch)
registerRoutePrefetch('/settings', SettingsPage.prefetch)
registerRoutePrefetch('/skills', SkillsPage.prefetch)
registerRoutePrefetch('/more', MorePage.prefetch)
registerRoutePrefetch('/workflow', WorkflowListPage.prefetch)

if (typeof window !== 'undefined') {
  const scheduleIdle = window.requestIdleCallback
    ? (callback: () => void) => window.requestIdleCallback(callback)
    : (callback: () => void) => window.setTimeout(callback, 0)
  scheduleIdle(() => void ChatPage.prefetch())
  scheduleIdle(() => void TodoBoardPage.prefetch())
}

function RouteLoading({ label = 'Loading page' }: { label?: string }) {
  useRouteLoadingPresence()
  return (
    <div className="flex h-dvh items-center justify-center bg-background" role="status" aria-label={label}>
      <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
    </div>
  )
}

function NotesFeatureRoute() {
  const { data: features, isPending } = useFeatures()
  if (isPending) return <RouteLoading />
  return features?.notesEnabled === true ? <NotesPage /> : <Navigate to="/" replace />
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error) {
    console.error('[AppErrorBoundary]', error)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <div className="text-subheadline font-medium text-foreground">Web UI needs a refresh</div>
        <button
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-subheadline font-medium text-white active:scale-[0.96] transition-transform"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>
      </div>
    )
  }
}

function AppShell() {
  return (
    <ClientProviders>
      <Suspense fallback={<RouteLoading />}>
        <Outlet />
      </Suspense>
    </ClientProviders>
  )
}

const routeElements: Partial<Record<AppRouteId, ReactNode>> = {
  // Its own boundary, and the announcement is the chat's rather than the shell's:
  // the pane that replaces this fallback carries the same wait straight on, so
  // the reader sees one loading state instead of "loading page" and then, a beat
  // later, "loading chat".
  chat: <Suspense fallback={<RouteLoading label="Loading chat" />}><ChatPage /></Suspense>,
  "chat-redirect": <Navigate to="/" replace />,
  "cron-list": <CronPage />,
  "cron-detail": <CronDetailPage />,
  // Todos v2 slice 6 (stage-C cutover): the board IS /todos and
  // /todos/:todoId is the full task page. The legacy list is gone.
  "todos-index": <TodosIndexRedirect />,
  "todo-board": <TodoBoardPage />,
  "todo-detail": <TaskPage />,
  "notes-list": <NotesFeatureRoute />,
  // Folder/note deep links: /notes/f/<folder>, /notes/n/<rel>, or both.
  notes: <NotesFeatureRoute />,
  "experiments-list": <ExperimentsPage />,
  "experiment-detail": <ExperimentDetailPage />,
  // GRS-021d: Kanban became Todos. Old links redirect.
  "kanban-redirect": <Navigate to="/todos" replace />,
  logs: <LogsPage />,
  limits: <LimitsPage />,
  org: <OrgPage />,
  settings: <SettingsPage />,
  "settings-plugins": <PluginsSettingsPage />,
  "skills-list": <SkillsPage />,
  "skill-detail": <SkillDetailPage />,
  file: <FilePage />,
  more: <MorePage />,
  "workflow-list": <WorkflowListPage />,
  "workflow-detail": <WorkflowPage />,
  "workflow-run": <WorkflowRunPage />,
  // The orb bench is screenshot-verified on built sandboxes, never on a dev
  // server pointed at a live gateway, so it has to survive the build. It is a
  // lazy route: nothing of it loads until someone types the path.
  "talk-orb": <TalkOrbHarnessPage />,
  redesign: <RedesignPage />,
}

const appRoutes: RouteObject[] = APP_ROUTES.flatMap((route) => {
  if (route.id === "plugin-contributed" || (route.availability === "development" && !import.meta.env.DEV)) return []
  const element = routeElements[route.id]
  return element ? [{ path: route.path, element }] : []
})

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      ...appRoutes,
      // A plugin's page, last and on the splat so the app's own routes are
      // matched first — a contribution can never shadow one of them.
      {
        path: '*',
        element: <ContributedRoute reserved={reservedSegments(APP_ROUTES.filter((route) => route.id !== "plugin-contributed").map((route) => route.path))} />,
      },
    ],
  },
])

// The Talk tool surface is driven by a voice transport rather than a render, so
// it navigates through the router directly instead of a hook. The promise is
// handed back rather than dropped: it is what tells the tool surface the route
// has actually landed, which is the only honest end for its latency clock.
registerTalkNavigator((path) => router.navigate(path))

// A plugin navigates from an event handler or a backend callback rather than
// from a render, so it reaches the router through a module-level handle for the
// same reason Talk does. The promise is dropped rather than handed back: unlike
// the voice surface, a plugin has no latency clock to time against the landing.
registerHostNavigator((path) => void router.navigate(path))

function App() {
  return (
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
  )
}

/**
 * The precached shell is what makes an installed Jinn open on its own paint
 * instead of on a network round trip. Production only: in `vite dev` a worker
 * would sit in front of the gateway proxy and serve yesterday's bundle.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.error('[service-worker] registration failed', error)
    })
  })
}

// Runs for the life of the document, so the unsubscribe is deliberately dropped.
startKeyboardInset()

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<App />)
