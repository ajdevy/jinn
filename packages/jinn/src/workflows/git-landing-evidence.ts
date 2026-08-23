import { execFile } from "node:child_process";
import type { WorkflowLandingVerifier } from "./run-closure.js";

/**
 * The default proof that a commit reached `main`: git's own ancestry check, run
 * in the checkout the Workflow itself named.
 *
 * An argument vector, never a shell string — both values come out of a phase's
 * submitted output, so both are input. Exit 1 is git's answer, and everything
 * else (no repository there any more, an object it never heard of) throws, so
 * the caller can tell "no" apart from "could not ask".
 */
export const gitLandingEvidence: WorkflowLandingVerifier = {
  mergedIntoMain({ commit, checkout }) {
    return new Promise((resolve, reject) => {
      execFile("git", ["-C", checkout, "merge-base", "--is-ancestor", commit, "main"],
        { timeout: 10_000, windowsHide: true }, (error) => {
          if (!error) resolve(true);
          else if (error.code === 1) resolve(false);
          else reject(error);
        });
    });
  },
};
