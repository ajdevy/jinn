import { scanOrg } from "../gateway/org.js";
import type { JinnConfig } from "../shared/types.js";
import { listLabels } from "../work-items/labels.js";
import { WORK_ITEM_STATUS_VALUES } from "../work-items/store.js";
import type { SearchVocabulary } from "./query-grammar.js";

/**
 * The live vocabulary inference is allowed to draw on: real statuses, real
 * people, real departments, real labels. This is the impure half of the
 * grammar, kept apart from it so every parsing rule stays unit-testable — and
 * it is why a plain word can only ever become a facet that actually exists.
 */
export function buildSearchVocabulary(config?: JinnConfig): SearchVocabulary {
  const employees = [...scanOrg(config).values()];
  return {
    statuses: WORK_ITEM_STATUS_VALUES,
    assignees: employees.map((employee) => employee.name),
    departments: [...new Set(employees.map((employee) => employee.department))],
    labels: listLabels().map((label) => label.name),
  };
}
