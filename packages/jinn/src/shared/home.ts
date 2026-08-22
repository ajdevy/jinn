import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve the current instance home at call time, before eager path constants. */
export function resolveJinnHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JINN_HOME) return path.resolve(env.JINN_HOME);
  const instance = env.JINN_INSTANCE || "jinn";
  return path.resolve(path.join(os.homedir(), `.${instance}`));
}

/** Resolve the canonical default home without applying instance overrides. */
export function resolveDefaultJinnHome(): string {
  return path.resolve(path.join(os.homedir(), ".jinn"));
}

/** The comparable identity of a home: two paths naming one directory resolve equal. */
export function resolveHomeIdentity(home: string): string {
  const absolute = path.resolve(home);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** Resolve Claude Code's config dir at call time; CLAUDE_CONFIG_DIR moves credentials,
 *  transcripts, skills and .claude.json together, so every consumer must agree on it. */
export function resolveClaudeConfigDir(): string {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.resolve(path.join(os.homedir(), ".claude"));
}

/** Claude Code's global config: beside the config dir by default, inside it once
 *  CLAUDE_CONFIG_DIR is set. Lives here rather than in claude-settings.ts so that
 *  "where does Claude Code keep its state" is one module, not two. */
export function claudeJsonPath(): string {
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(resolveClaudeConfigDir(), ".claude.json");
  return path.join(os.homedir(), ".claude.json");
}

/**
 * Resolve the instance NAME (not the home path) for user-facing hints such as
 * the `jinn -i <name> pair` command. Derives from an explicit JINN_INSTANCE,
 * else the JINN_HOME/passed-home basename with its leading dot stripped
 * (`~/.jinn-yorio` -> `jinn-yorio`), falling back to the default `jinn`.
 */
export function resolveJinnInstance(jinnHome?: string): string {
  if (process.env.JINN_INSTANCE) return process.env.JINN_INSTANCE;
  const home = jinnHome ?? process.env.JINN_HOME;
  if (home) {
    const base = path.basename(path.resolve(home));
    const name = base.startsWith(".") ? base.slice(1) : base;
    if (name) return name;
  }
  return "jinn";
}

/** The exact CLI command that pairs a browser to this instance. */
export function pairCommandFor(instance: string): string {
  return instance && instance !== "jinn" ? `jinn -i ${instance} pair` : "jinn pair";
}

/** Resolve the durable per-instance key without freezing JINN_HOME at import. */
export function resolveMcpSessionCapabilityKeyFile(jinnHome = resolveJinnHome()): string {
  return path.join(jinnHome, "secrets", "mcp-session-capability.key");
}
