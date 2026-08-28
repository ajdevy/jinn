import { execFile } from "node:child_process";
import { loadConfig } from "../shared/config.js";
import type { WorkflowLandingVerifier } from "./run-closure.js";

export interface GitLandingTarget {
  branch: string;
}

function landingTarget(): GitLandingTarget {
  const delivery = loadConfig().workflows?.delivery;
  return { branch: delivery?.branch ?? "main" };
}

/**
 * Proof that a commit reached the designated branch in the reported checkout.
 *
 * An argument vector, never a shell string — both values come out of a phase's
 * submitted output, so both are input. Exit 1 is git's answer, and everything
 * else (no repository there any more, an object it never heard of) throws, so
 * the caller can tell "no" apart from "could not ask".
 */
export function createGitLandingEvidence(target: GitLandingTarget): WorkflowLandingVerifier {
  const branchRef = `refs/heads/${target.branch}`;
  return {
    async mergedIntoMain({ commit, checkout }) {
      return new Promise((resolve, reject) => {
        execFile("git", ["-C", checkout, "merge-base", "--is-ancestor", commit, branchRef],
          { timeout: 10_000, windowsHide: true }, (error) => {
            if (!error) resolve(true);
            else if (error.code === 1) resolve(false);
            else reject(error);
          });
      });
    },
  };
}

export const gitLandingEvidence: WorkflowLandingVerifier = {
  mergedIntoMain(input) {
    return createGitLandingEvidence(landingTarget()).mergedIntoMain(input);
  },
};
