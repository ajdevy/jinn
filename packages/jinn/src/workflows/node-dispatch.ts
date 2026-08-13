import type { Employee, ModelRegistry } from "../shared/types.js";
import { interpolateWorkflowPrompt, resolveBinding, type WorkflowBindingContext } from "./bindings.js";
import { continuationPrompt, resolveEmployeeContinuation } from "./employee-continuation.js";
import type { EmployeeNode } from "./model.js";
import type { WorkflowRepository } from "./repository.js";
import type { ResolvedEmployeeConfig, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import type { WorkflowTodoDispatchOverride } from "./todo-ports.js";

/**
 * What a run's bindings see, and what an Employee node's attempt actually runs
 * on. Both are read once per attempt, immediately before dispatch, so an
 * override set while an earlier attempt was in flight lands on the next one.
 */

const DEFAULT_ATTEMPT_TIMEOUT_MINUTES = 180;

/** The narrow slice of the runner's options this resolution needs. Declared
 *  here rather than imported from `runner.ts` so the dependency runs one way. */
export interface DispatchResolutionDeps {
  employees: () => ReadonlyMap<string, Employee>;
  models: () => ModelRegistry;
  repository: WorkflowRepository;
  executor: Pick<WorkflowSessionExecutor, "resumableEngineSession">;
  todoDispatch?: WorkflowTodoDispatchOverride;
}

export function bindingContext(run: WorkflowRunDetail): WorkflowBindingContext {
  const itemIndex = run.trigger.payload.itemIndex;
  return {
    input: run.input,
    trigger: {
      kind: run.trigger.kind,
      payload: run.trigger.payload,
      ...(Number.isInteger(itemIndex) ? { itemIndex: itemIndex as number } : {}),
    },
    run: { id: run.id, startedAt: run.startedAt, ...(run.trigger.todoId ? { todoId: run.trigger.todoId } : {}) },
    nodes: Object.fromEntries(run.nodeRuns.map((node) => [node.nodeId, {
      status: node.status, output: node.output ?? null, error: node.error ?? null,
    }])),
  };
}

export function resolveString(
  binding: Parameters<typeof resolveBinding<string>>[0],
  context: WorkflowBindingContext,
  label: string,
): string {
  const value = resolveBinding(binding, context);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must resolve to a nonempty string.`);
  return value;
}

type Override = { engine: string | null; model: string | null } | undefined;

/** Whatever pinned this attempt away from the employee's own defaults, in the
 *  order that wins: the bound Todo first, then the node's own configuration.
 *  `undefined` on either side means nothing pinned it and the employee decides. */
function pinnedSelection(node: EmployeeNode, context: WorkflowBindingContext, override: Override): {
  engine: string | undefined;
  model: string | undefined;
} {
  if (override?.engine) return { engine: override.engine, model: override.model ?? undefined };
  return {
    engine: node.config.engine ? resolveString(node.config.engine, context, "Engine") : undefined,
    model: node.config.model ? resolveString(node.config.model, context, "Model") : undefined,
  };
}

type ModelInfo = ModelRegistry[string]["models"][number];

/** The engine this attempt runs on and the model it runs with, given whatever
 *  pinned it. A pinned engine with no model of its own takes THAT engine's
 *  default, never the employee's model, which it would not be registered for. */
function resolveTarget(
  pinned: { engine: string | undefined; model: string | undefined },
  employee: Employee,
  models: () => ModelRegistry,
): { engine: string; model: string; modelInfo: ModelInfo } {
  const engine = pinned.engine ?? employee.engine;
  const registry = models()[engine];
  if (!registry?.available) throw new Error(`Workflow engine "${engine}" is not available.`);
  const model = pinned.model ?? (pinned.engine ? registry.defaultModel : employee.model || registry.defaultModel);
  const modelInfo = registry.models.find((candidate) => candidate.id === model);
  if (!modelInfo) throw new Error(`Workflow model "${model}" is not available for engine "${engine}".`);
  return { engine, model, modelInfo };
}

/** The employee's configured effort only applies while the employee's own
 *  engine and model do: a pin can land on a model that does not know it. An
 *  effort the node asked for explicitly still has to be one the model has. */
function resolveEffort(
  node: EmployeeNode,
  context: WorkflowBindingContext,
  employee: Employee,
  pinned: boolean,
  modelInfo: ModelInfo,
): ResolvedEmployeeConfig["effort"] {
  const effort = (node.config.effort
    ? resolveString(node.config.effort, context, "Effort")
    : pinned ? undefined : employee.effortLevel) as ResolvedEmployeeConfig["effort"];
  if (effort && (!modelInfo.supportsEffort || !modelInfo.effortLevels.includes(effort))) {
    throw new Error(`Workflow effort "${effort}" is not available for model "${modelInfo.id}".`);
  }
  return effort;
}

export function resolveDispatch(
  run: WorkflowRunDetail,
  node: EmployeeNode,
  options: DispatchResolutionDeps,
): ResolvedEmployeeConfig {
  const context = bindingContext(run);
  const employeeId = resolveString(node.config.employee, context, "Employee");
  const employee = options.employees().get(employeeId);
  if (!employee) throw new Error(`Workflow employee "${employeeId}" is not available.`);
  // ICI-733: the bound Todo's override outranks the node's own engine/model. It
  // exists to move a Todo whose attempts keep failing onto a different engine,
  // and a workflow that pinned the failing one would otherwise defeat it.
  const override = run.trigger.todoId ? options.todoDispatch?.read(run.trigger.todoId) : undefined;
  const pinned = pinnedSelection(node, context, override);
  const { engine, model, modelInfo } = resolveTarget(pinned, employee, options.models);
  const effort = resolveEffort(node, context, employee, Boolean(pinned.engine || pinned.model), modelInfo);
  const continuedFrom = resolveEmployeeContinuation(run, node, engine, {
    repository: options.repository,
    resumableEngineSession: (id, target) => options.executor.resumableEngineSession(id, target),
  });
  // Only the prompt going out: an unused delta must not fail a cold round over a binding it never reads.
  interpolateWorkflowPrompt(continuationPrompt(node, Boolean(continuedFrom)), context);
  return {
    employeeId, engine, model, ...(effort ? { effort } : {}), ...(continuedFrom ? { continuedFrom } : {}),
    retry: node.config.retry ?? { attempts: 1, delaySeconds: 0, backoff: "fixed" },
    timeoutMinutes: node.config.timeoutMinutes ?? DEFAULT_ATTEMPT_TIMEOUT_MINUTES,
  };
}
