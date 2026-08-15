import type { JsonValue, WorkflowDefinition } from "../../workflows/model.js";
import type { WorkflowDefinitionSummary } from "../../workflows/repository.js";
import { PluginHostError } from "./errors.js";
import { requireWorkflowService } from "./gateway-link.js";
import { assertVerbAllowed } from "./permissions.js";

/** A Workflow, as both `list` and `get` answer it. The two agree on purpose:
 *  `getDefinition` also carries the node graph, and handing a plugin the graph
 *  would put the Workflow engine's own vocabulary into this contract. */
export interface PluginWorkflow {
  id: string;
  title: string;
  description: string | null;
  revision: number;
  enabled: boolean;
  updatedAt: string;
}

export interface PluginWorkflowRun {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
}

export interface PluginHostWorkflows {
  /** One page of Workflows, at the repository's own default size. */
  list(): PluginWorkflow[];
  get(workflowId: string): PluginWorkflow;
  start(workflowId: string, input?: Record<string, JsonValue>): Promise<PluginWorkflowRun>;
}

/** The summary normalizes an absent description to null and the full definition
 *  leaves it off, so one narrowing serves both. */
function asWorkflow(source: WorkflowDefinitionSummary | WorkflowDefinition): PluginWorkflow {
  return {
    id: source.id,
    title: source.title,
    description: source.description ?? null,
    revision: source.revision,
    enabled: source.enabled,
    updatedAt: source.updatedAt,
  };
}

export function workflowVerbs(pluginId: string): PluginHostWorkflows {
  return {
    list() {
      assertVerbAllowed(pluginId, "workflows.list");
      return requireWorkflowService("workflows.list").listDefinitions({}).items.map(asWorkflow);
    },
    get(workflowId) {
      assertVerbAllowed(pluginId, "workflows.get");
      const definition = requireWorkflowService("workflows.get").getDefinition(workflowId);
      if (!definition) {
        throw new PluginHostError(
          "workflows.get",
          "not-found",
          `host.workflows.get found no Workflow "${workflowId}"`,
        );
      }
      return asWorkflow(definition);
    },
    async start(workflowId, input = {}) {
      assertVerbAllowed(pluginId, "workflows.start");
      const run = await requireWorkflowService("workflows.start").startManual({ workflowId, input });
      // The detail embeds the whole definition; a plugin gets the four fields
      // this contract names and nothing it did not ask for.
      return {
        id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
      };
    },
  };
}
