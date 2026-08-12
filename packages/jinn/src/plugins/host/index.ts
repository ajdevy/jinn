import { randomUUID } from "node:crypto";
import { scanOrg } from "../../gateway/org.js";
import type { Employee, Session } from "../../shared/types.js";
import { addComment, type WorkItemComment } from "../../work-items/comments.js";
import { createWorkItem, listWorkItems, type ListWorkItemsFilter, type WorkItem } from "../../work-items/store.js";
import {
  emitPluginNotice,
  requirePluginHostGateway,
  type PluginNoticeLevel,
} from "./gateway-link.js";
import { assertVerbAllowed } from "./permissions.js";

/**
 * The typed verb tier as a plugin's *backend* sees it — the same six verbs the
 * browser SDK offers, over the gateway's own in-process functions rather than
 * over HTTP.
 *
 * Inside this process the HTTP hop would be wrong twice: it would need a token
 * to call the gateway it is already running in, and it would turn one
 * transactional write into a request that can fail halfway. The delegation
 * transaction composes its writes in-process for the same reason.
 *
 * Every verb passes the permission gate first. A verb that skipped it would be
 * a verb no policy could ever refuse.
 */

/** What a plugin may set when it mints a Todo. Provenance is not on the list —
 *  this module stamps it, so a plugin cannot claim another author. */
export interface PluginTodoDraft {
  title: string;
  body?: string;
  assignee?: string;
  department?: string;
  parentId?: string;
  priority?: number;
}

export interface PluginSpawnRequest {
  prompt: string;
  employee?: string;
  engine?: string;
  model?: string;
}

export interface PluginHost {
  todos: {
    list(filter?: ListWorkItemsFilter): WorkItem[];
    create(draft: PluginTodoDraft): WorkItem;
    comment(todoId: string, body: string): WorkItemComment;
  };
  sessions: {
    spawn(request: PluginSpawnRequest): Promise<Session>;
  };
  employees: {
    list(): Employee[];
  };
  /** Say something on the dashboard. Never throws: a dropped notice is not
   *  worth taking a plugin's watcher down over. */
  notify(message: string, level?: PluginNoticeLevel): void;
}

/**
 * How a row records the plugin that caused it.
 *
 * The random tail matters: `createWorkItem` is idempotent on
 * `(source, sourceRef)`, so a constant ref would silently collapse every Todo a
 * plugin ever mints into the first one.
 */
function provenanceRef(pluginId: string): string {
  return `plugin:${pluginId}:${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function todoVerbs(pluginId: string, author: string): PluginHost["todos"] {
  return {
    list(filter) {
      assertVerbAllowed(pluginId, "todos.list");
      return listWorkItems(filter);
    },
    create(draft) {
      assertVerbAllowed(pluginId, "todos.create");
      return createWorkItem({
        ...draft,
        // A plugin is third-party code the operator mounted, which is what a
        // connector is; the enum has no truer member, and widening a persisted
        // one for the sake of a label would be the wrong trade.
        source: "connector",
        sourceRef: provenanceRef(pluginId),
        createdBy: author,
      });
    },
    comment(todoId, body) {
      assertVerbAllowed(pluginId, "todos.comment");
      return addComment({ workItemId: todoId, body, author, authorKind: "system" });
    },
  };
}

function sessionVerbs(pluginId: string): PluginHost["sessions"] {
  return {
    async spawn(request) {
      assertVerbAllowed(pluginId, "sessions.spawn");
      const outcome = await requirePluginHostGateway("sessions.spawn").spawnSession({
        prompt: request.prompt,
        employee: request.employee ?? null,
        engine: request.engine,
        model: request.model,
        provenance: { source: "plugin", sourceRef: provenanceRef(pluginId) },
      });
      if (!outcome.ok) throw new Error(`host.sessions.spawn refused: ${outcome.error}`);
      return outcome.session;
    },
  };
}

export function createPluginHost(pluginId: string): PluginHost {
  const author = `plugin:${pluginId}`;

  return {
    todos: todoVerbs(pluginId, author),
    sessions: sessionVerbs(pluginId),

    employees: {
      list() {
        assertVerbAllowed(pluginId, "employees.list");
        return [...scanOrg().values()];
      },
    },

    notify(message, level = "info") {
      assertVerbAllowed(pluginId, "notify");
      emitPluginNotice(pluginId, message, level);
    },
  };
}
