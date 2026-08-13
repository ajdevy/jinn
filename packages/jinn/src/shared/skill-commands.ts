import fs from "node:fs";
import { SKILLS_DIR } from "./paths.js";

/** Names of installed jinn skills (directories under ~/.jinn/skills).
 *  Read fresh per call — one cheap readdir, never a hot path. Skills are added
 *  and removed while the gateway runs, so a cached set would answer for a
 *  workspace that no longer exists. */
export function installedSkillNames(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

/** Decide how a user message must be fed into an engine's TUI.
 *
 *  A leading `@` (mention) or `!` (bash-mode) always gets a space prepended so
 *  the TUI treats it as literal text instead of swallowing the turn.
 *
 *  A leading `/` is space-prepended ONLY when its first token names an installed
 *  jinn skill (so the model reads it and invokes the skill). Any other
 *  `/command` is passed through raw, letting engine-native commands like
 *  `/compact`, `/clear`, `/model` actually fire. */
export function neutralizeForPaste(text: string): string {
  if (/^[@!]/.test(text)) return " " + text;
  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/\s/, 1)[0];
    return installedSkillNames().has(cmd) ? " " + text : text;
  }
  return text;
}
