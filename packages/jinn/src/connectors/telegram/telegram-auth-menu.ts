import type TelegramBot from "node-telegram-bot-api";
import { AUTH_MENU_COMMANDS } from "./auth-flow-types.js";
import type { AuthLogger } from "./auth-flow-types.js";
import { TelegramAuthMenuState } from "./telegram-auth-menu-state.js";

const RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 15 * 60_000;
type TelegramCommand = { command: string; description: string };

export class TelegramAuthMenu {
  private readonly bot: TelegramBot;
  private readonly state: TelegramAuthMenuState;
  private readonly ownerIds: readonly number[];
  private readonly hasAuthFlow: boolean;
  private readonly logger: AuthLogger;
  private readonly configured = new Set<number>();
  private configuration: Promise<void> | null = null;
  private configurationGeneration: number | null = null;
  private lifecycleGeneration = 0;
  private stopped = true;
  private failures = 0;
  private retryNotBefore = 0;

  constructor(options: { bot: TelegramBot; state: TelegramAuthMenuState; ownerIds: readonly number[]; hasAuthFlow: boolean; logger: AuthLogger }) {
    this.bot = options.bot;
    this.state = options.state;
    this.ownerIds = options.ownerIds;
    this.hasAuthFlow = options.hasAuthFlow;
    this.logger = options.logger;
  }

  get isPersisted(): boolean {
    return this.state.persisted;
  }

  start(): void {
    this.stopped = false;
    this.lifecycleGeneration += 1;
    void this.configure(this.lifecycleGeneration);
  }

  ensure(): void {
    if (!this.state.persisted) void this.configure(this.lifecycleGeneration);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifecycleGeneration += 1;
    const pending = this.configuration;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([pending.catch(() => undefined), new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      })]);
      if (timer) clearTimeout(timer);
    }
    this.configuration = null;
    this.configurationGeneration = null;
  }

  private async configure(generation: number): Promise<void> {
    if (this.stopped || generation !== this.lifecycleGeneration || this.state.persisted || Date.now() < this.retryNotBefore) return;
    if (this.state.stateReadFailed) {
      this.state.reload();
      if (this.state.stateReadFailed) return void this.record(true);
    }
    if (this.configuration) {
      if (this.configurationGeneration === generation) return this.configuration;
      this.configuration = null;
      this.configurationGeneration = null;
    }
    const work = this.configureOnce(generation);
    this.configuration = work;
    this.configurationGeneration = generation;
    try { await work; } finally {
      if (this.configuration === work) {
        this.configuration = null;
        this.configurationGeneration = null;
      }
    }
  }

  private async configureOnce(generation: number): Promise<void> {
    let failed = await this.state.reconcileStaleOwners(new Set(this.ownerIds), async (ownerId) => {
      await this.bot.deleteMyCommands({ scope: { type: "chat", chat_id: ownerId } });
    });
    if (!this.active(generation)) return;
    const pendingOwners = this.ownerIds.filter((id) => !this.configured.has(id));
    if (!this.hasAuthFlow || pendingOwners.length === 0) {
      this.state.persist(this.ownerIds, this.configured);
      return void this.record(failed);
    }
    const commands = await this.readCommands(generation);
    if (commands === undefined) return;
    if (!commands) {
      this.state.persist(this.ownerIds, this.configured);
      return void this.record(true);
    }
    this.state.persist(this.ownerIds, this.configured);
    failed = (await this.configureOwners(pendingOwners, commands, generation)) || failed;
    if (!this.active(generation)) return;
    this.state.persist(this.ownerIds, this.configured);
    this.record(failed);
  }

  private async readCommands(generation: number): Promise<TelegramCommand[] | null | undefined> {
    try {
      const existing = await this.bot.getMyCommands();
      if (!this.active(generation)) return undefined;
      const merged = new Map(existing.map((command) => [command.command, command]));
      for (const command of AUTH_MENU_COMMANDS) merged.set(command.command, { ...command });
      return [...merged.values()];
    } catch (error) {
      this.logger.warn?.(`[telegram] Failed to read the default Telegram command menu: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async configureOwners(ownerIds: readonly number[], commands: TelegramCommand[], generation: number): Promise<boolean> {
    let failed = false;
    for (const ownerId of ownerIds) {
      if (!this.active(generation)) return failed;
      try {
        await this.bot.setMyCommands(commands, { scope: { type: "chat", chat_id: ownerId } });
        if (!this.active(generation)) return failed;
        this.configured.add(ownerId);
      } catch (error) {
        failed = true;
        this.logger.warn?.(`[telegram] Failed to configure auth command menu for owner ${ownerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return failed;
  }

  private active(generation: number): boolean {
    return !this.stopped && generation === this.lifecycleGeneration;
  }

  private record(failed: boolean): void {
    if (!failed && this.state.persisted) {
      this.failures = 0;
      this.retryNotBefore = 0;
      return;
    }
    this.failures += 1;
    const delay = this.failures === 1 ? 0 : Math.min(RETRY_DELAY_MS * 2 ** (this.failures - 2), MAX_RETRY_DELAY_MS);
    this.retryNotBefore = Date.now() + delay;
  }
}
