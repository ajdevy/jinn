/**
 * The typed verb tier of the host API, in the browser.
 *
 * Every verb is one request to an endpoint the dashboard already calls, over the
 * app's own `authFetch` — so a plugin inherits the operator's session and the
 * gateway's own authorization, and no route exists that serves plugins alone.
 * Each verb passes the permission gate first; that call is the seam, and a verb
 * that skipped it would be a verb no policy could ever refuse.
 */
import { authFetch } from '@/lib/auth'
import { PluginSdkError } from './errors'
import { assertVerbAllowed, type PluginHostVerb } from './host-permissions'

/** The eight states a Todo can be in, as the gateway spells them. */
export type HostTodoStatus =
  | 'backlog'
  | 'assigned'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'escalated'
  | 'cancelled'

/** A Todo as the list endpoint returns it: the columns a board renders, not the
 *  whole stored row. */
export interface HostTodo {
  id: string
  title: string
  status: HostTodoStatus
  assignee: string | null
  department: string | null
  parentId: string | null
  updatedAt: string
}

export interface HostTodoFilter {
  status?: HostTodoStatus
  assignee?: string
  /** Only Todos with no parent — the objective view, without their sub-tasks. */
  rootsOnly?: boolean
  /** The gateway defaults to 20 and caps the page at 100. */
  limit?: number
}

/** What a plugin may set when it mints a Todo. Provenance is not on the list:
 *  the gateway stamps who created it, so a plugin cannot claim another author. */
export interface HostTodoDraft {
  title: string
  body?: string
  assignee?: string
  department?: string
  parentId?: string
  /** 0 (highest) to 3 (lowest); the gateway defaults to 2. */
  priority?: number
}

export interface HostTodoComment {
  id: string
  workItemId: string
  author: string
  body: string
  createdAt: string
}

export interface HostSessionSpawn {
  prompt: string
  /** An employee from the org. Omitted, the session runs on gateway defaults. */
  employee?: string
  engine?: string
  model?: string
}

export interface HostSession {
  id: string
  engine: string
  employee: string | null
  status: string
  title: string | null
}

export interface HostEmployee {
  name: string
  displayName: string
  department: string
  rank: string
  engine: string
  model: string
  /** The first line of the persona, when it is short enough to be a label. */
  role?: string
}

export interface PluginHostTodos {
  list(filter?: HostTodoFilter): Promise<HostTodo[]>
  create(draft: HostTodoDraft): Promise<HostTodo>
  comment(todoId: string, body: string): Promise<HostTodoComment>
}

export interface PluginHostSessions {
  spawn(request: HostSessionSpawn): Promise<HostSession>
}

export interface PluginHostEmployees {
  list(): Promise<HostEmployee[]>
}

/** The gateway's own message when it refused, or the bare status when the body
 *  was not the error envelope. Either beats "request failed". */
async function failureOf(verb: PluginHostVerb, response: Response): Promise<PluginSdkError> {
  let detail = `${response.status} ${response.statusText}`.trim()
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) detail = body.error
  } catch {
    // A non-JSON error body leaves the status line, which is still true.
  }
  return new PluginSdkError(`[plugin-sdk] host.${verb} failed: ${detail}`)
}

async function request<T>(verb: PluginHostVerb, path: string, init?: RequestInit): Promise<T> {
  assertVerbAllowed(verb)
  const response = await authFetch(path, init)
  if (!response.ok) throw await failureOf(verb, response)
  return (await response.json()) as T
}

function write<T>(verb: PluginHostVerb, path: string, body: unknown): Promise<T> {
  return request<T>(verb, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function todoQuery(filter: HostTodoFilter | undefined): string {
  const params = new URLSearchParams()
  if (filter?.status) params.set('status', filter.status)
  if (filter?.assignee) params.set('assignee', filter.assignee)
  if (filter?.rootsOnly) params.set('rootsOnly', 'true')
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  const query = params.toString()
  return query ? `?${query}` : ''
}

export const todos: PluginHostTodos = {
  async list(filter) {
    const page = await request<{ workItems: HostTodo[] }>(
      'todos.list',
      `/api/work-items${todoQuery(filter)}`,
    )
    return page.workItems
  },
  async create(draft) {
    const created = await write<{ workItem: HostTodo }>('todos.create', '/api/work-items', draft)
    return created.workItem
  },
  async comment(todoId, body) {
    const added = await write<{ comment: HostTodoComment }>(
      'todos.comment',
      `/api/work-items/${encodeURIComponent(todoId)}/comments`,
      { body },
    )
    return added.comment
  },
}

export const sessions: PluginHostSessions = {
  spawn(spawnRequest) {
    return write<HostSession>('sessions.spawn', '/api/sessions', spawnRequest)
  },
}

export const employees: PluginHostEmployees = {
  async list() {
    const org = await request<{ employees: HostEmployee[] }>('employees.list', '/api/org')
    return org.employees
  },
}
