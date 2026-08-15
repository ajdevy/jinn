import { scanOrg } from "../../gateway/org.js";
import type { Employee } from "../../shared/types.js";
import { assertVerbAllowed } from "./permissions.js";

export interface PluginHostEmployees {
  list(): Employee[];
}

export function employeeVerbs(pluginId: string): PluginHostEmployees {
  return {
    list() {
      assertVerbAllowed(pluginId, "employees.list");
      return [...scanOrg().values()];
    },
  };
}
