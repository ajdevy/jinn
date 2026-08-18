import { toolDefinitions } from "@/components/talk/tools/registry"
import type { TalkControlManifest } from "../control-manifest"

/** Legacy browser executors wrapped as manifest entries for isolated driver tests. */
export function browserControlFixture(): TalkControlManifest {
  return {
    version: 1,
    operations: toolDefinitions().map((tool) => ({
      ...tool,
      parameters: {
        ...tool.parameters,
        required: [...(tool.parameters.required ?? [])],
      } as TalkControlManifest["operations"][number]["parameters"],
      target: "browser",
      exposure: "always",
      intent: "test",
      mutability: "effect",
      operatorOnly: false,
      verification: "browser-receipt",
    })),
  }
}
