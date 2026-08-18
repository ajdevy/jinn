/**
 * Provider declarations derived from Talk's authoritative control manifest.
 *
 * The gateway mints exactly the catalog the browser later configures on the
 * realtime session. Execution target and authority remain manifest metadata;
 * the provider sees only its ordinary function declaration.
 */
import type { RealtimeTool } from "../../shared/voice.js";
import { buildTalkControlManifest } from "../control/manifest.js";

function providerTool(operation: ReturnType<typeof buildTalkControlManifest>["operations"][number]): RealtimeTool {
  return {
    name: operation.name,
    description: operation.description,
    parameters: structuredClone(operation.parameters),
  };
}

/** Intent names accepted by the compatibility expansion endpoint. */
export const TALK_TOOL_INTENTS = [
  ...new Set(buildTalkControlManifest().operations.map((operation) => operation.intent)),
].sort();

export function allTools(): RealtimeTool[] {
  return buildTalkControlManifest().operations.map(providerTool);
}

export function alwaysOnTools(): RealtimeTool[] {
  return buildTalkControlManifest().operations
    .filter((operation) => operation.exposure === "always")
    .map(providerTool);
}

export function isKnownIntent(intent: string): boolean {
  return TALK_TOOL_INTENTS.includes(intent);
}

/**
 * The manifest currently exposes the universal catalog at open. Keep this
 * compatibility seam for older clients without manufacturing a second list.
 */
export function toolsForIntents(intents: readonly string[], exposedNames: readonly string[]): RealtimeTool[] {
  const requested = new Set(intents);
  const exposed = new Set(exposedNames);
  return buildTalkControlManifest().operations
    .filter((operation) => operation.exposure === "on-intent" && requested.has(operation.intent) && !exposed.has(operation.name))
    .map(providerTool);
}

/** Estimated provider-context cost of a tool list. */
export function estimateToolTokens(tools: readonly RealtimeTool[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

export function toolsByName(names: readonly string[]): RealtimeTool[] {
  const catalog = new Map(allTools().map((tool) => [tool.name, tool]));
  return names.flatMap((name) => {
    const tool = catalog.get(name);
    return tool ? [tool] : [];
  });
}
