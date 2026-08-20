import type { WorkItemStatus } from './store.js';

/** Declared edges: from → the set of legal targets (design §1.1's diagram).
 *  Governs the human and derived lanes; the agent lane (`opts.agent`) and the
 *  workflow re-arm lane (`opts.requeue`) are bounded by their caller's target
 *  allowlist instead. */
export const EDGES: Readonly<Record<WorkItemStatus, ReadonlySet<WorkItemStatus>>> = {
  // `done` from backlog/assigned covers trivially-completed work (e.g. a
  // gate-only workflow run that finishes without ever spawning a session) —
  // rare, but refusing it would strand a truthful terminal.
  backlog: new Set(['assigned', 'executing', 'in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  assigned: new Set(['backlog', 'executing', 'in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  executing: new Set(['in_review', 'blocked', 'done', 'cancelled', 'escalated']),
  in_review: new Set(['executing', 'done', 'blocked', 'cancelled', 'escalated']),
  blocked: new Set(['backlog', 'assigned', 'executing', 'in_review', 'done', 'cancelled', 'escalated']),
  // Sticky terminals: leaving them is HUMAN-ONLY (enforced in transitions.ts, not by
  // edge absence — the operator can route an escalated/closed item anywhere sensible).
  escalated: new Set(['backlog', 'assigned', 'executing', 'in_review', 'done', 'blocked', 'cancelled']),
  done: new Set(['backlog']),
  cancelled: new Set(['backlog']),
};
