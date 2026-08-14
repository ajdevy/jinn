/**
 * A Todo's verify policy: its shape, and the one validator both write
 * boundaries use.
 *
 * `verify_policy` is a JSON TEXT column, so its schema lives in code rather than
 * in the DDL. It used to live in code TWICE — once in the MCP tool layer, once
 * in the gateway route layer — as an exact duplicate, which meant a new key had
 * to be added in two places and could refuse a value at one boundary while
 * accepting it at the other. This module is that single copy; the MCP side turns
 * a refusal into its own error type, and nothing else differs.
 *
 * `deliverable` declares WHERE the Todo's product lands. A `repo` Todo is
 * verified the ordinary way, from the diff. A `workspace` Todo delivers into the
 * operator's instance home — a Note, a skill, an org file — which the build
 * pipeline's verifier deliberately cannot read, so its acceptance is routed to
 * an actor that already has that access and the verifier rules on the diff, the
 * gates and the repo-side evidence manifest instead. The field records the
 * route; it grants no access to anything.
 */

export const VERIFY_MODES = ['trust', 'verify', 'thorough'] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export const DELIVERABLE_ROUTES = ['repo', 'workspace'] as const;
export type DeliverableRoute = (typeof DELIVERABLE_ROUTES)[number];

/** Absent means `repo`, so every Todo written before this field existed keeps
 *  its exact meaning and is persisted byte-identically. */
export const DEFAULT_DELIVERABLE_ROUTE: DeliverableRoute = 'repo';

export interface VerifyPolicy {
  mode: VerifyMode;
  verifier?: { employee?: string; engine?: string; model?: string };
  maxRounds?: number;
  deliverable?: DeliverableRoute;
}

const VERIFY_POLICY_KEYS = new Set(['mode', 'verifier', 'maxRounds', 'deliverable']);
const VERIFIER_KEYS = ['employee', 'engine', 'model'] as const;

export type VerifyPolicyResult =
  | { ok: true; value: VerifyPolicy | null }
  | { ok: false; error: string };

export function deliverableRoute(policy: VerifyPolicy | null | undefined): DeliverableRoute {
  return policy?.deliverable ?? DEFAULT_DELIVERABLE_ROUTE;
}

function asObject(value: unknown, name: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `${name} must be a JSON object` };
  return { ok: true, value: value as Record<string, unknown> };
}

function validateVerifier(value: unknown): { ok: true; value: NonNullable<VerifyPolicy['verifier']> } | { ok: false; error: string } {
  const rec = asObject(value, 'verifyPolicy.verifier');
  if (!rec.ok) return rec;
  const extras = Object.keys(rec.value).filter((key) => !(VERIFIER_KEYS as readonly string[]).includes(key));
  if (extras.length > 0) {
    return { ok: false, error: `verifyPolicy.verifier has unknown key(s) ${extras.join(', ')}; only employee, engine, and model are allowed` };
  }
  const verifier: NonNullable<VerifyPolicy['verifier']> = {};
  for (const key of VERIFIER_KEYS) {
    const field = rec.value[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !field.trim()) {
      return { ok: false, error: `verifyPolicy.verifier.${key} must be a non-empty string` };
    }
    verifier[key] = field.trim();
  }
  return { ok: true, value: verifier };
}

/** The three optional keys, each absent-or-valid, folded into `policy`. Returns
 *  the first reason one of them is wrong, or undefined when all of them are
 *  right. Absent stays absent: a key nobody set is never invented here, so a
 *  policy written before a key existed persists byte-identically. */
function applyOptionalKeys(rec: Record<string, unknown>, policy: VerifyPolicy): string | undefined {
  if (rec.maxRounds !== undefined) {
    const maxRounds = rec.maxRounds;
    if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) {
      return 'verifyPolicy.maxRounds must be an integer from 1 to 20';
    }
    policy.maxRounds = maxRounds;
  }
  if (rec.deliverable !== undefined) {
    if (!(DELIVERABLE_ROUTES as readonly unknown[]).includes(rec.deliverable)) {
      return `verifyPolicy.deliverable must be one of ${DELIVERABLE_ROUTES.join(', ')}`;
    }
    policy.deliverable = rec.deliverable as DeliverableRoute;
  }
  if (rec.verifier !== undefined) {
    const verifier = validateVerifier(rec.verifier);
    if (!verifier.ok) return verifier.error;
    policy.verifier = verifier.value;
  }
  return undefined;
}

/** Null and undefined mean "no policy", which is a legal value: provenance
 *  supplies the default mode. Anything else must be a policy in full. */
export function validateVerifyPolicy(value: unknown): VerifyPolicyResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  const rec = asObject(value, 'verifyPolicy');
  if (!rec.ok) return rec;
  const extras = Object.keys(rec.value).filter((key) => !VERIFY_POLICY_KEYS.has(key));
  if (extras.length > 0) {
    return { ok: false, error: `verifyPolicy has unknown key(s) ${extras.join(', ')}; only mode, verifier, maxRounds, and deliverable are allowed` };
  }
  if (!(VERIFY_MODES as readonly unknown[]).includes(rec.value.mode)) {
    return { ok: false, error: `verifyPolicy.mode must be one of ${VERIFY_MODES.join(', ')}` };
  }
  const policy: VerifyPolicy = { mode: rec.value.mode as VerifyMode };
  const error = applyOptionalKeys(rec.value, policy);
  return error ? { ok: false, error } : { ok: true, value: policy };
}
