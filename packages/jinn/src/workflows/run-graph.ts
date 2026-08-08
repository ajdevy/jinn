/** Reading a run's node graph: what a node's runtime record is, what feeds it,
 *  and which sessions upstream of it are still readable. */

import type { WorkflowNodeRunRecord, WorkflowRunDetail } from "./runtime.js";

export function nodeRun(run: WorkflowRunDetail, nodeId: string): WorkflowNodeRunRecord {
  const found = run.nodeRuns.find((node) => node.nodeId === nodeId);
  if (!found) throw new Error(`Workflow node ${nodeId} was not found.`);
  return found;
}

export function incoming(run: WorkflowRunDetail, nodeId: string) {
  return run.definition.edges.filter((edge) => edge.to.nodeId === nodeId);
}

/** Every completed ancestor of `nodeId`, with the session that produced it when
 *  there is one — the transcripts a phase is allowed to read for context. */
export function upstreamSessions(run: WorkflowRunDetail, nodeId: string): Array<{ nodeId: string; sessionId?: string }> {
  const ancestors = new Set<string>();
  const pending = incoming(run, nodeId).map((edge) => edge.from.nodeId);
  while (pending.length > 0) {
    const upstreamId = pending.pop()!;
    if (ancestors.has(upstreamId)) continue;
    ancestors.add(upstreamId);
    pending.push(...incoming(run, upstreamId).map((edge) => edge.from.nodeId));
  }
  return run.definition.nodes.flatMap((authored) => {
    const runtime = nodeRun(run, authored.id);
    if (!ancestors.has(authored.id) || runtime.status !== "completed") return [];
    const attempt = run.attempts.filter((candidate) => candidate.nodeId === authored.id
      && candidate.status === "completed" && candidate.sessionId).at(-1);
    const sessionId = runtime.output?.sessionId ?? attempt?.sessionId;
    return [{ nodeId: authored.id, ...(sessionId ? { sessionId } : {}) }];
  });
}
