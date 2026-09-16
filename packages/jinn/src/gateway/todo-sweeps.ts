import type { WorkflowRepository } from "../workflows/repository.js";
import { startAvailabilityResumes } from "./availability-resume.js";
import { startTodoRecovery } from "./todo-recovery.js";

/** Availability resume (PLA-153) plus bounded Todo recovery (PLA-240). */
export function startTodoSweeps(repository: WorkflowRepository): () => void {
  const stopResumes = startAvailabilityResumes(repository);
  const stopRecovery = startTodoRecovery(repository);
  return () => {
    stopResumes();
    stopRecovery();
  };
}
