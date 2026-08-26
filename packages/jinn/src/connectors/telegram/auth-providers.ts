import { execFile as nodeExecFile } from "node:child_process";

export type AuthProvider = "claude" | "codex";

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

const STATUS_TIMEOUT_MS = 15_000;

export function runCommand(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        const failure = error as (Error & { status?: unknown }) | null;
        if (!failure) {
          resolve({ stdout: String(stdout ?? ""), exitCode: 0 });
        } else if (typeof failure.status === "number") {
          resolve({ stdout: String(stdout ?? ""), exitCode: failure.status });
        } else {
          reject(failure);
        }
      },
    );
  });
}

export interface ProviderDefinition {
  label: string;
  login: readonly [file: string, args: readonly string[]];
  status(run: RunCommand): Promise<boolean>;
}

export const PROVIDERS: Record<AuthProvider, ProviderDefinition> = {
  claude: {
    label: "Claude",
    login: ["claude", ["auth", "login", "--claudeai"]],
    async status(run) {
      const result = await run("claude", ["auth", "status", "--json"], STATUS_TIMEOUT_MS);
      if (result.exitCode !== 0) return false;
      const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn !== "boolean") {
        throw new Error("provider authentication status could not be read");
      }
      return parsed.loggedIn;
    },
  },
  codex: {
    label: "Codex",
    login: ["codex", ["login", "--device-auth"]],
    async status(run) {
      return (await run("codex", ["login", "status"], STATUS_TIMEOUT_MS)).exitCode === 0;
    },
  },
};
