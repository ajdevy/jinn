import { queryClient } from "@/lib/query-client"
import { queryKeys } from "@/lib/query-keys"
import {
  chatPath,
  cronPath,
  experimentPath,
  orgPath,
  resolveTodoId,
  todoPath,
  todosPath,
  workflowPath,
} from "./nav-paths"
import { talkNavigator } from "./router-handle"
import { params, str, type TalkTool, type ToolArgs, type ToolResult } from "./tool-spec"

/**
 * One navigation tool per domain, each a thin wrapper over a pure path function.
 *
 * Every executor commits its route change before its first `await` — in fact
 * before it returns at all — so the transport can fire on partial intent instead
 * of waiting for the model to finish speaking.
 */

function go(path: string): ToolResult | Promise<ToolResult> {
  const navigate = talkNavigator()
  if (!navigate) {
    return { ok: false, error: "The app is not mounted yet, so there is nothing to navigate. Try again once it has loaded." }
  }
  // Issued here, with nothing awaited in front of it. What is returned is the
  // router's own completion, so the caller's clock stops when the destination
  // has landed instead of when the request was made.
  const committed = navigate(path)
  return Promise.resolve(committed).then(() => ({ ok: true, data: { path } }))
}

/** The prefix root Todos are minted under. `/api/onboarding` is fetched once at
 *  boot and never goes stale, so this read is synchronous in a running app. */
function companyTodoPrefix(): string | null {
  const onboarding = queryClient.getQueryData<{ todoPrefix: string | null }>(queryKeys.onboarding)
  return onboarding?.todoPrefix ?? null
}

const BOARD = str(
  'Which board: "my" for Todos the operator started, "attention" for what needs them, "everything", or a department slug.',
)
const STATUS = str("Restrict the board to one status.", [
  "all", "backlog", "assigned", "executing", "blocked", "in_review", "escalated", "done", "cancelled",
])

const openTodos: TalkTool = {
  name: "open_todos",
  description:
    'Open the Todo board, optionally scoped and filtered. Use board "my" for anything the operator describes as theirs — "todos I started", "my requests".',
  exposure: "always",
  parameters: params({
    board: BOARD,
    status: STATUS,
    assignee: str("Only Todos assigned to this employee."),
    department: str("Only Todos in this department slug."),
    source: str("Only Todos created this way.", ["human", "delegation", "cron", "workflow", "session", "connector", "goal"]),
    label: str("Only Todos carrying this label."),
    due: str("Only Todos due within this window.", ["overdue", "today", "week", "month"]),
    q: str("Free-text search over titles."),
  }),
  execute: (args: ToolArgs) => go(todosPath(args)),
}

const openTodo: TalkTool = {
  name: "open_todo",
  description: 'Open one Todo\'s page. The id may be spoken with its prefix ("ABC-59") or as a bare number ("59").',
  exposure: "always",
  parameters: params({ id: str("The Todo id.") }, ["id"]),
  execute: (args: ToolArgs) => {
    const resolved = resolveTodoId(args.id, companyTodoPrefix())
    if ("error" in resolved) return { ok: false, error: resolved.error }
    return go(todoPath(resolved.id))
  },
}

const openWorkflows: TalkTool = {
  name: "open_workflows",
  description: "Open the Workflow list, or one workflow by id. Ask for the runs lens to see its run history instead of its editor.",
  exposure: "on-intent",
  parameters: params({
    id: str("The workflow id, which is a slug such as \"nightly-digest\"."),
    lens: str("Which lens to open the workflow in.", ["editor", "runs"]),
  }),
  execute: (args: ToolArgs) => go(workflowPath(args)),
}

const openExperiments: TalkTool = {
  name: "open_experiments",
  description: "Open the Experiments list, or one experiment by id.",
  exposure: "on-intent",
  parameters: params({ id: str("The experiment id.") }),
  execute: (args: ToolArgs) => go(experimentPath(args)),
}

const openChats: TalkTool = {
  name: "open_chats",
  description: "Open chat, or one session by id.",
  exposure: "always",
  parameters: params({ sessionId: str("The session id to select.") }),
  execute: (args: ToolArgs) => go(chatPath(args)),
}

const openOrg: TalkTool = {
  name: "open_org",
  description: "Open the org chart, optionally selecting one employee.",
  exposure: "on-intent",
  parameters: params({ employee: str("The employee name to select, such as \"a-lead\".") }),
  execute: (args: ToolArgs) => go(orgPath(args)),
}

const openCron: TalkTool = {
  name: "open_cron",
  description: "Open the scheduled jobs, one job by id, the week view, or the jobs filtered by whether they are enabled.",
  exposure: "on-intent",
  parameters: params({
    id: str("The cron job id."),
    lens: str("Which lens to open.", ["jobs", "week"]),
    filter: str("Restrict the job list.", ["all", "enabled", "disabled"]),
  }),
  execute: (args: ToolArgs) => go(cronPath(args)),
}

export const NAVIGATE_TOOLS: readonly TalkTool[] = [
  openTodos,
  openTodo,
  openWorkflows,
  openExperiments,
  openChats,
  openOrg,
  openCron,
]
