import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthLogger } from "./auth-flow-types.js";
import { JINN_HOME } from "../../shared/paths.js";

const STATE_DIR = path.join(JINN_HOME, "state", "telegram-auth-menu-owners");

function stateDirectory(): string {
  const scope = process.env.VITEST ? process.env.JINN_TELEGRAM_AUTH_TEST_SCOPE : undefined;
  return scope ? path.join(STATE_DIR, scope) : STATE_DIR;
}

function ownerId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function staleOwnerError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /\b(?:chat not found|bot was blocked(?: by (?:the )?user)?|user is deactivated)\b/i.test(detail);
}

export class TelegramAuthMenuState {
  readonly file: string;
  previousOwnerIds: readonly number[];
  stateReadFailed = false;
  stateUnreadable = false;
  persisted = false;
  private readonly logger: AuthLogger;
  private readonly reconciledStale = new Set<number>();

  constructor(connectorId: string, logger: AuthLogger) {
    const hash = createHash("sha256").update(connectorId, "utf8").digest("hex").slice(0, 24);
    this.file = path.join(stateDirectory(), `${hash}.json`);
    this.logger = logger;
    this.previousOwnerIds = this.read();
  }

  reload(): void {
    this.stateReadFailed = false;
    this.previousOwnerIds = this.read();
  }

  async reconcileStaleOwners(current: ReadonlySet<number>, remove: (ownerId: number) => Promise<void>): Promise<boolean> {
    let failed = false;
    for (const ownerId of this.previousOwnerIds) {
      if (current.has(ownerId) || this.reconciledStale.has(ownerId)) continue;
      try {
        await remove(ownerId);
        this.reconciledStale.add(ownerId);
      } catch (error) {
        if (staleOwnerError(error)) {
          this.reconciledStale.add(ownerId);
          this.logger.warn?.(`[telegram] Stale auth command menu owner ${ownerId} is no longer addressable`);
        } else {
          failed = true;
          this.logger.warn?.(`[telegram] Failed to clear stale auth command menu for owner ${ownerId}`);
        }
      }
    }
    return failed;
  }

  persist(currentOwnerIds: readonly number[], configured: ReadonlySet<number>): boolean {
    if (this.persisted) return true;
    const current = new Set(currentOwnerIds);
    const unreconciled = this.previousOwnerIds.some((id) => !current.has(id) && !this.reconciledStale.has(id));
    const durable = unreconciled ? [...new Set([...this.previousOwnerIds, ...currentOwnerIds])] : [...currentOwnerIds];
    const complete = currentOwnerIds.every((id) => configured.has(id));
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (this.stateUnreadable) this.archiveCorrupt();
      const temporary = this.file + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(durable) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.stateUnreadable = false;
      this.persisted = complete && !unreconciled;
    } catch (error) {
      this.logger.warn?.(`[telegram] Failed to persist auth command menu owners: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.persisted;
  }

  private read(): readonly number[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      this.stateReadFailed = true;
      this.logger.error?.("[telegram] Failed to read auth command menu owner state");
      return [];
    }
    try {
      const parsed = JSON.parse(contents) as unknown;
      if (!Array.isArray(parsed)) throw new Error("state is not an array");
      const values = [...new Set(parsed.map(ownerId).filter((id): id is number => id !== null))];
      if (values.length !== parsed.length) {
        this.stateUnreadable = true;
        this.logger.warn?.("[telegram] Auth command menu owner state contains invalid entries");
      }
      return values;
    } catch {
      this.stateUnreadable = true;
      this.logger.error?.("[telegram] Failed to parse auth command menu owner state; preserving it for forensics");
      return [];
    }
  }

  private archiveCorrupt(): void {
    try {
      fs.copyFileSync(this.file, this.file + ".corrupt-" + Date.now());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
