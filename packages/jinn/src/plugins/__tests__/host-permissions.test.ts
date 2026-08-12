import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-plugin-perms-"));
process.env.JINN_HOME = tmpHome;

/**
 * The gateway half of the permission seam, proved by denying one verb at a time.
 *
 * The gate is mocked rather than configured because v1 ships no denial policy —
 * the seam is the deliverable, not the policy. Mocking it is also what makes the
 * test load-bearing: a verb that never called the gate would sail through its
 * own denial and the expectation below would fail. That is the property under
 * test, not the throw itself.
 */
const denied = vi.hoisted(() => ({ verb: null as string | null }));

vi.mock("../host/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host/permissions.js")>();
  return {
    ...actual,
    assertVerbAllowed: (pluginId: string, verb: import("../host/permissions.js").PluginHostVerb) => {
      if (verb === denied.verb) throw new actual.PluginHostDeniedError(pluginId, verb);
      actual.assertVerbAllowed(pluginId, verb);
    },
  };
});

type Permissions = typeof import("../host/permissions.js");
let permissions: Permissions;
let createPluginHost: typeof import("../host/index.js").createPluginHost;
let setPluginHostGateway: typeof import("../host/gateway-link.js").setPluginHostGateway;

beforeAll(async () => {
  permissions = await import("../host/permissions.js");
  ({ createPluginHost } = await import("../host/index.js"));
  ({ setPluginHostGateway } = await import("../host/gateway-link.js"));
});

/** One call per verb, so every verb in the union is exercised by name. */
function callsFor(pluginId: string): Record<Permissions["PLUGIN_HOST_VERBS"][number], () => unknown> {
  const host = createPluginHost(pluginId);
  // Minted before any verb is denied, so commenting exercises `todos.comment`
  // alone rather than failing on the `todos.create` that set it up.
  const commentable = host.todos.create({ title: "commentable" });
  return {
    "todos.list": () => host.todos.list(),
    "todos.create": () => host.todos.create({ title: "a todo" }),
    "todos.comment": () => host.todos.comment(commentable.id, "noted"),
    "sessions.spawn": () => host.sessions.spawn({ prompt: "draft a reply" }),
    "employees.list": () => host.employees.list(),
    notify: () => host.notify("something happened"),
  };
}

beforeEach(() => {
  denied.verb = null;
  setPluginHostGateway({
    spawnSession: async () => ({ ok: true, session: { id: "sess-stub" } as never, dispatched: false }),
    emitNotice: () => {},
  });
});

afterEach(() => {
  setPluginHostGateway(null);
});

describe("denying one verb", () => {
  it.each(["todos.list", "todos.create", "todos.comment", "sessions.spawn", "employees.list", "notify"] as const)(
    "refuses %s and leaves the other five working",
    async (target) => {
      const calls = callsFor("mailbox");
      denied.verb = target;

      for (const verb of permissions.PLUGIN_HOST_VERBS) {
        const attempt = Promise.resolve().then(() => calls[verb]());
        if (verb === target) {
          await expect(attempt).rejects.toBeInstanceOf(permissions.PluginHostDeniedError);
        } else {
          // Settling at all is the assertion: a refusal would reject, and
          // `notify` legitimately resolves to nothing.
          await expect(attempt).resolves.not.toBeInstanceOf(Error);
        }
      }
    },
  );

  it("names the plugin and the verb on the error", async () => {
    denied.verb = "sessions.spawn";

    await expect(callsFor("mailbox")["sessions.spawn"]()).rejects.toMatchObject({
      name: "PluginHostDeniedError",
      pluginId: "mailbox",
      verb: "sessions.spawn",
    });
  });
});

describe("the v1 policy", () => {
  it("grants every verb, so nothing is refused today", async () => {
    const actual = await vi.importActual<Permissions>("../host/permissions.js");

    for (const verb of actual.PLUGIN_HOST_VERBS) {
      expect(() => actual.assertVerbAllowed("mailbox", verb)).not.toThrow();
    }
  });
});
