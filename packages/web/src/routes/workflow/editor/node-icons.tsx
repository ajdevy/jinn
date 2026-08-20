import {
  CalendarClock,
  Flag,
  GitMerge,
  OctagonX,
  Radio,
  ShieldCheck,
  Split,
  SquareCheckBig,
  Timer,
  UserRound,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react"
import type { WorkflowNodeType, WorkflowNodeWire } from "./ports"

interface Tint {
  bg: string
  fg: string
}

const TINT: Record<WorkflowNodeType, Tint> = {
  trigger: { bg: "var(--accent-fill)", fg: "var(--accent)" },
  employee: { bg: "color-mix(in srgb, var(--system-blue) 15%, transparent)", fg: "var(--system-blue)" },
  "workflow-call": { bg: "color-mix(in srgb, var(--system-indigo) 15%, transparent)", fg: "var(--system-indigo)" },
  condition: { bg: "color-mix(in srgb, var(--system-purple) 15%, transparent)", fg: "var(--system-purple)" },
  merge: { bg: "var(--fill-tertiary)", fg: "var(--text-secondary)" },
  approval: { bg: "color-mix(in srgb, var(--system-orange) 16%, transparent)", fg: "var(--system-orange)" },
  wait: { bg: "var(--fill-tertiary)", fg: "var(--text-secondary)" },
  end: { bg: "color-mix(in srgb, var(--system-green) 15%, transparent)", fg: "var(--system-green)" },
}

const END_FAILURE_TINT: Tint = { bg: "color-mix(in srgb, var(--system-red) 15%, transparent)", fg: "var(--system-red)" }

const TRIGGER_ICON: Record<string, LucideIcon> = {
  manual: Zap,
  schedule: CalendarClock,
  event: Radio,
  "todo-status": SquareCheckBig,
  "workflow-call": Workflow,
}

const TYPE_ICON: Record<WorkflowNodeType, LucideIcon> = {
  trigger: Zap,
  employee: UserRound,
  "workflow-call": Workflow,
  condition: Split,
  merge: GitMerge,
  approval: ShieldCheck,
  wait: Timer,
  end: Flag,
}

function iconFor(type: WorkflowNodeType, node?: WorkflowNodeWire): { Icon: LucideIcon; tint: Tint } {
  if (type === "trigger") {
    const Icon = node?.type === "trigger" ? (TRIGGER_ICON[node.config.kind] ?? Zap) : Zap
    return { Icon, tint: TINT.trigger }
  }
  if (type === "end" && node?.type === "end" && node.config.result === "failure") {
    return { Icon: OctagonX, tint: END_FAILURE_TINT }
  }
  return { Icon: TYPE_ICON[type], tint: TINT[type] }
}

/** The type-identity tile: tinted rounded square + glyph, sized for cards and menus. */
export function NodeTypeIcon({
  type,
  node,
  size = 32,
  iconSize = 15,
}: {
  type: WorkflowNodeType
  node?: WorkflowNodeWire
  size?: number
  iconSize?: number
}) {
  const { Icon, tint } = iconFor(type, node)
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[9px]"
      style={{ width: size, height: size, background: tint.bg, color: tint.fg }}
    >
      <Icon size={iconSize} strokeWidth={2} />
    </span>
  )
}
