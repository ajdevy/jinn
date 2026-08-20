import type { WorkflowDefinition } from './model.js';
import type { WorkflowValidationIssue } from './issues.js';

/**
 * The rules a Workflow Call node has to pass before it can run.
 *
 * The iteration rules exist so that a loop nobody bounded is not something a
 * definition can express. `maxRounds` parses as optional only because a missing
 * bound has to survive far enough to be named here: a definition that fails the
 * schema can report nothing more useful than "invalid".
 */

export const ITERATION_EXHAUSTED_PORT = 'exhausted';

export function workflowCallTargetIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  return definition.nodes.flatMap((node, index) => node.type === 'workflow-call'
    && node.config.workflowId.source === 'fixed' && node.config.workflowId.value === definition.id
    ? [{
        code: 'workflow-call-self-reference',
        message: 'A Workflow Call cannot target its own defining Workflow.',
        nodeId: node.id,
        path: `nodes.${index}.config.workflowId`,
      }]
    : []);
}

export function workflowCallIterationIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  return definition.nodes.flatMap((node, index) => {
    if (node.type !== 'workflow-call' || !node.config.iterate) return [];
    const base = `nodes.${index}.config.iterate`;
    const issues: WorkflowValidationIssue[] = [];
    if (node.config.iterate.maxRounds === undefined) {
      issues.push({ code: 'unbounded-iteration',
        message: 'A Workflow Call that iterates must set maxRounds, so the loop is bounded by the definition rather than by whatever the rounds decide.',
        nodeId: node.id, path: `${base}.maxRounds` });
    }
    if (node.config.items) {
      issues.push({ code: 'iteration-with-fanout',
        message: 'A Workflow Call cannot both iterate and fan out over items. Fan-out is a width fixed up front; iteration is a depth decided round by round.',
        nodeId: node.id, path: `nodes.${index}.config.items` });
    }
    if (!definition.edges.some((edge) => edge.from.nodeId === node.id && edge.from.port === ITERATION_EXHAUSTED_PORT)) {
      issues.push({ code: 'iteration-missing-exhausted-route',
        message: `A Workflow Call that iterates must wire its ${ITERATION_EXHAUSTED_PORT} port, so a loop that spends every round still has somewhere to go.`,
        nodeId: node.id, path: `nodes.${index}.config.iterate` });
    }
    return issues;
  });
}
