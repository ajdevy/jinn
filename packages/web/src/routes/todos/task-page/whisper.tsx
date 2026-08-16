import { Bell, ChevronRight, CornerDownRight, Link2, Paperclip, Pencil, Plus, Tags } from "lucide-react"
import type { Employee, WorkItemEventWire } from "@/lib/api"
import { STATUS_LABEL } from "@/lib/todos"
import { displayNameOf, formatRelativeTime } from "../util"

/* One audit event read back as a sentence: who did it, and what it was. The
 * feed that orders these lines lives in activity.tsx. */

interface Whisper {
  Icon: typeof Pencil
  text: string
  tinted?: boolean
}

/** A kind's sentence: fixed when it never varies, a reader of the event's
 *  detail when it does. A table rather than a switch keeps every kind to one
 *  readable mapping instead of one branch. */
type WhisperRule = Whisper | ((detail: Record<string, unknown>, event: WorkItemEventWire) => Whisper)

const WHISPERS: Record<string, WhisperRule> = {
  created: { Icon: Plus, text: "created this todo" },
  child_created: (detail) => ({
    Icon: Plus,
    text: `added a sub-task${typeof detail.childId === "string" ? ` ${detail.childId}` : ""}`,
  }),
  status_change: (detail, event) => {
    if (detail.bounce === true) {
      return { Icon: CornerDownRight, text: `sent it back · round ${typeof detail.rounds === "number" ? detail.rounds : "?"}` }
    }
    return { Icon: ChevronRight, text: `moved it to ${event.toStatus ? STATUS_LABEL[event.toStatus] : "?"}` }
  },
  escalated: (detail) => ({
    Icon: CornerDownRight,
    text: detail.reason === "max-rounds-exhausted" ? "escalated it — review rounds exhausted" : "escalated it",
    tinted: true,
  }),
  // Naming the guard is the point: an unnamed hold reads as silence, and the
  // operator re-arms blind until they give up. Kept short so the name itself
  // survives the line's truncation at 390px.
  respawn_guard_held: (detail) => ({
    Icon: CornerDownRight,
    text: `held the dispatch${typeof detail.guard === "string" ? ` — ${detail.guard}` : ""}`,
    tinted: true,
  }),
  note: (detail) => {
    if (typeof detail.assignee === "string") return { Icon: Pencil, text: `assigned ${detail.assignee}` }
    if (detail.approvalEscalated === true) return { Icon: Bell, text: "escalated the approval" }
    return { Icon: Pencil, text: "added a note" }
  },
  metadata_edited: { Icon: Pencil, text: "edited the details" },
  approval_requested: { Icon: Bell, text: "asked for approval" },
  approval_decided: (detail) => ({
    Icon: Bell,
    text: detail.decision === "approve" ? "approved it" : "sent the approval back",
  }),
  attachment_added: (detail) => ({
    Icon: Paperclip,
    text: `attached ${typeof detail.filename === "string" ? detail.filename : "a file"}`,
  }),
  attachment_removed: { Icon: Paperclip, text: "removed an attachment" },
  label_changed: { Icon: Tags, text: "changed the labels" },
  relation_added: { Icon: Link2, text: "linked a related todo" },
  relation_removed: { Icon: Link2, text: "removed a relation" },
  session_linked: { Icon: Link2, text: "linked a session" },
}

export function whisperOf(event: WorkItemEventWire): Whisper {
  const rule = WHISPERS[event.kind]
  if (rule === undefined) return { Icon: Pencil, text: event.kind.replace(/_/g, " ") }
  return typeof rule === "function" ? rule(event.detail ?? {}, event) : rule
}

function actorLabel(actor: string | null, byName: Map<string, Employee>): string {
  if (!actor || actor === "system") return "The gateway"
  if (actor === "operator") return "You"
  if (actor.startsWith("session:")) return "A session"
  return displayNameOf(actor, byName)
}

export function WhisperLine({ event, byName }: { event: WorkItemEventWire; byName: Map<string, Employee> }) {
  const whisper = whisperOf(event)
  return (
    <div className="flex items-center gap-2 py-[7px] text-[12.5px] text-[var(--text-tertiary)]" data-testid={`whisper-${event.id}`}>
      <span className="mr-1.5 grid w-4 flex-none place-items-center text-[var(--text-quaternary)]">
        <whisper.Icon size={12} strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0 truncate">
        <span className={`font-semibold ${whisper.tinted ? "text-[var(--system-red)]" : "text-[var(--text-secondary)]"}`}>
          {actorLabel(event.actor, byName)}
        </span>{" "}
        {whisper.text}
      </span>
      <span className="flex-none text-[var(--text-quaternary)]">· {formatRelativeTime(event.createdAt)}</span>
    </div>
  )
}
