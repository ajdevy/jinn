import { PROVIDERS, runCommand, type AuthProvider, type RunCommand } from "./auth-providers.js";
import { logger } from "../../shared/logger.js";
import {
  AUTH_MENU_COMMANDS, AUTH_PAYLOAD_PATTERN, CLOCK, DEFAULT_FLOW_TTL_SECONDS, DEFAULT_SPAWN_PTY,
  appendUtf8Tail, extractDiscovery, flowKey, isAuthCommandPrefix, isTimeout, ownerId,
  parseAuthCommand, resolveOwnerIds, type ActiveFlow, type AuthBot, type AuthChatId, type AuthClock,
  type AuthCommand, type AuthLogger, type AuthMessage, type AuthPty, type ProviderState, type SpawnPty,
  type TelegramAuthOptions, type Verification,
} from "./auth-support.js";
export * from "./auth-support.js";
interface ConnectorAuthBot extends AuthBot {
  sendMessage(chatId: string, text: string): Promise<unknown>;
  deleteMessage(chatId: string, messageId: number): Promise<unknown>;
}
export function createTelegramAuth(
  bot: ConnectorAuthBot,
  config: { ownerUserIds?: readonly number[]; flowTtlSeconds?: number },
  allowFrom: ReadonlySet<number> | null,
  env: NodeJS.ProcessEnv = process.env,
): TelegramAuth {
  return new TelegramAuth({
    bot,
    ownerUserIds: config.ownerUserIds ?? [],
    allowFrom,
    env,
    flowTtlSeconds: config.flowTtlSeconds,
    send: async (chatId, text) => { await bot.sendMessage(String(chatId), text); },
    deleteMessage: async (chatId, messageId) => { await bot.deleteMessage(String(chatId), Number(messageId)); },
    logger,
  });
}
export class TelegramAuth {
  private readonly bot: AuthBot;
  private readonly owners: ReadonlySet<number>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sendMessage: TelegramAuthOptions["send"];
  private readonly deleteMessage: TelegramAuthOptions["deleteMessage"];
  private readonly spawnPty: SpawnPty;
  private readonly run: RunCommand;
  private readonly clock: AuthClock;
  private readonly logger: AuthLogger;
  private readonly flowTtlMs: number;
  private readonly active = new Map<string, ActiveFlow>();
  private readonly pending = new Set<ActiveFlow>();
  private readonly generations = new Map<string, number>();
  constructor(options: TelegramAuthOptions) {
    this.bot = options.bot;
    this.owners = new Set(resolveOwnerIds(options.ownerUserIds, options.allowFrom, options.logger));
    this.env = options.env;
    this.sendMessage = options.send;
    this.deleteMessage = options.deleteMessage;
    this.spawnPty = options.spawnPty ?? DEFAULT_SPAWN_PTY;
    this.run = options.runCommand ?? runCommand;
    this.clock = options.clock ?? CLOCK;
    this.logger = options.logger;
    const ttl = options.flowTtlSeconds && options.flowTtlSeconds > 0 ? options.flowTtlSeconds : DEFAULT_FLOW_TTL_SECONDS;
    this.flowTtlMs = ttl * 1000;
  }
  start(): void {
    for (const owner of this.owners) {
      void Promise.resolve().then(() => this.bot.setMyCommands(AUTH_MENU_COMMANDS, { scope: { type: "chat", chat_id: owner } })).catch(() => {
        this.logger.warn?.(`[telegram] Could not publish auth command menu for owner ${owner}`);
      });
    }
  }
  async handle(message: AuthMessage): Promise<boolean> {
    const raw = message.text.trim();
    if (!isAuthCommandPrefix(raw)) return false;
    const command = parseAuthCommand(raw);
    const id = ownerId(message.userId);
    const owner = id !== null && this.owners.has(id);
    const warning = await this.scrub(message, owner);
    if (!owner || id === null) return true;
    if (message.chatType !== "private") {
      await this.safeSend(message.chatId, "Authentication commands are available only in a private chat.", warning);
      return true;
    }
    if (!command || command.kind === "rejected") {
      await this.safeSend(message.chatId, "Unsupported authentication command.", warning);
      return true;
    }
    await this.dispatch(id, message, command, warning);
    return true;
  }

  async handleIncoming(userId: number | string, chatType: string, chatId: AuthChatId, messageId: number | string | undefined, text: string): Promise<boolean> {
    return this.handle({ userId, chatType, chatId, messageId, text });
  }

  private async dispatch(owner: number, message: AuthMessage, command: AuthCommand, warning: string): Promise<void> {
    if (command.kind === "start") return this.startFlow(owner, command.provider, message.chatId, warning);
    if (command.kind === "status") return this.status(owner, message.chatId, warning);
    if (command.kind === "cancel") return this.cancel(owner, message.chatId, warning);
    if (command.kind !== "input") return;
    return this.writeCode(owner, command, message.chatId, warning);
  }

  async status(owner: number, chatId: AuthChatId, warning = ""): Promise<void> {
    const states = await Promise.all((Object.keys(PROVIDERS) as AuthProvider[]).map(async (provider) => {
      const state = await this.providerState(provider);
      return `${PROVIDERS[provider].label}: ${state}.`;
    }));
    await this.safeSend(chatId, `${this.activeStatus(owner)}\n${states.join("\n")}`, warning);
  }

  stop(): void {
    for (const flow of this.active.values()) this.clear(flow, true);
    for (const flow of this.pending) flow.invalidated = true;
    this.pending.clear();
  }

  private async startFlow(owner: number, provider: AuthProvider, chatId: AuthChatId, warning: string): Promise<void> {
    const key = flowKey(owner, provider);
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const previous = this.active.get(key);
    if (previous) this.clear(previous, true);
    const [file, args] = PROVIDERS[provider].login;
    let child: AuthPty;
    try {
      child = this.spawnPty(file, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: this.env,
      });
    } catch {
      this.logger.error?.("[telegram-auth] failed to start provider process");
      await this.safeSend(chatId, `${PROVIDERS[provider].label} authentication failed to start.`, warning);
      return;
    }
    const flow: ActiveFlow = {
      key,
      generation,
      ownerId: owner,
      provider,
      chatId,
      pty: child,
      discoveryTail: "",
      urlSent: false,
      codeSent: false,
      invalidated: false,
    };
    this.active.set(key, flow);
    this.attach(flow);
    await this.safeSend(chatId, `${PROVIDERS[provider].label} authentication started. Follow the instructions below. Send a short device code with /auth_input <code>. If Claude redirects to a localhost /callback URL, send that full URL with /auth_input; only its one-time code is passed to the CLI.`, warning);
  }

  private attach(flow: ActiveFlow): void {
    const data = flow.pty.onData((chunk) => {
      if (!this.isCurrent(flow)) return;
      flow.discoveryTail = appendUtf8Tail(flow.discoveryTail, chunk);
      const discovery = extractDiscovery(flow.discoveryTail);
      if (discovery.url && !flow.discoveredUrl) flow.discoveredUrl = discovery.url;
      if (discovery.code && !flow.discoveredCode) flow.discoveredCode = discovery.code;
      const lines = this.discoveryLines(flow);
      if (lines.length > 1) void this.safeSend(flow.chatId, lines.join("\n"));
    });
    const exit = flow.pty.onExit((event) => void this.finish(flow, event.exitCode));
    flow.dataSubscription = data && typeof data === "object" ? data : undefined;
    flow.exitSubscription = exit && typeof exit === "object" ? exit : undefined;
    flow.timer = this.clock.setTimeout(() => this.timeout(flow), this.flowTtlMs);
  }

  private async finish(flow: ActiveFlow, exitCode: number): Promise<void> {
    if (!this.isCurrentGeneration(flow)) return;
    const lines = this.discoveryLines(flow);
    if (lines.length > 1) await this.safeSend(flow.chatId, lines.join("\n"));
    this.detach(flow, false);
    if (exitCode !== 0) {
      await this.safeSend(flow.chatId, `${PROVIDERS[flow.provider].label} authentication failed.`);
      return;
    }
    this.pending.add(flow);
    let verification: Verification;
    try {
      verification = { verified: await PROVIDERS[flow.provider].status(this.run), timedOut: false };
    } catch (error) {
      verification = { verified: false, timedOut: isTimeout(error) };
    } finally {
      this.pending.delete(flow);
    }
    if (!this.isCurrentGeneration(flow)) return;
    if (!verification.verified) {
      const message = verification.timedOut
        ? `${PROVIDERS[flow.provider].label} authentication verification timed out. Try again with /auth_${flow.provider}.`
        : `${PROVIDERS[flow.provider].label} authentication failed: could not be verified. Try again with /auth_${flow.provider}.`;
      await this.safeSend(flow.chatId, message);
      return;
    }
    await this.safeSend(flow.chatId, `${PROVIDERS[flow.provider].label} authentication succeeded: authenticated.`);
  }

  private async providerState(provider: AuthProvider): Promise<ProviderState> {
    try {
      return await PROVIDERS[provider].status(this.run) ? "authenticated" : "not authenticated";
    } catch (error) {
      return isTimeout(error) ? "verification timed out" : "status unavailable";
    }
  }

  private activeStatus(owner: number): string {
    const providers = [...this.active.values()]
      .filter((flow) => flow.ownerId === owner)
      .map((flow) => PROVIDERS[flow.provider].label)
      .sort();
    return providers.length === 0 ? "No authentication flow is active." : `Active authentication flows: ${providers.join(", ")}.`;
  }

  private async cancel(owner: number, chatId: AuthChatId, warning: string): Promise<void> {
    const flows = [...this.active.values()].filter((flow) => flow.ownerId === owner);
    const pending = [...this.pending].filter((flow) => flow.ownerId === owner);
    if (flows.length === 0 && pending.length === 0) {
      await this.safeSend(chatId, "No authentication flow is active.", warning);
      return;
    }
    for (const flow of flows) this.clear(flow, true);
    for (const flow of pending) flow.invalidated = true;
    await this.safeSend(chatId, "Authentication cancelled.", warning);
  }

  private async writeCode(owner: number, input: Extract<AuthCommand, { kind: "input" }>, chatId: AuthChatId, warning: string): Promise<void> {
    const flows = [...this.active.values()].filter((flow) => flow.ownerId === owner);
    if (flows.length === 0) {
      await this.safeSend(chatId, "No authentication flow is active.", warning);
    } else if (flows.length > 1) {
      await this.safeSend(chatId, "Authentication input is ambiguous while multiple providers are active.", warning);
    } else if (input.source === "claude-callback" && flows[0].provider !== "claude") {
      await this.safeSend(chatId, "A Claude callback URL can only be used with /auth_claude.", warning);
    } else {
      try {
        flows[0].pty.write(`${input.code}\r`);
        if (warning) await this.safeSend(chatId, warning);
      } catch {
        this.logger.warn?.("[telegram-auth] failed to write authentication input");
        await this.safeSend(chatId, "Authentication input failed.", warning);
      }
    }
  }

  private discoveryLines(flow: ActiveFlow): string[] {
    const lines = ["Continue authentication:"];
    if (flow.discoveredUrl && !flow.urlSent) {
      flow.urlSent = true;
      lines.push(flow.discoveredUrl);
    }
    if (flow.discoveredCode && !flow.codeSent) {
      flow.codeSent = true;
      lines.push(`Device code: ${flow.discoveredCode}`);
    }
    return lines;
  }

  private timeout(flow: ActiveFlow): void {
    if (!this.isCurrent(flow)) return;
    this.clear(flow, true);
    void this.safeSend(flow.chatId, `Authentication timed out. Try again with /auth_${flow.provider}.`);
  }

  private clear(flow: ActiveFlow, kill: boolean): void {
    if (this.active.get(flow.key) !== flow) return;
    this.detach(flow, true);
    if (kill) {
      try { flow.pty.kill(); } catch { this.logger.warn?.("[telegram-auth] failed to stop provider process"); }
    }
  }

  private detach(flow: ActiveFlow, invalidate: boolean): void {
    if (this.active.get(flow.key) !== flow) return;
    this.active.delete(flow.key);
    if (invalidate) flow.invalidated = true;
    if (flow.timer !== undefined) this.clock.clearTimeout(flow.timer);
    flow.timer = undefined;
    flow.dataSubscription?.dispose?.();
    flow.exitSubscription?.dispose?.();
  }

  private isCurrent(flow: ActiveFlow): boolean {
    return this.active.get(flow.key) === flow && !flow.invalidated && this.generations.get(flow.key) === flow.generation;
  }

  private isCurrentGeneration(flow: ActiveFlow): boolean {
    return !flow.invalidated && this.generations.get(flow.key) === flow.generation;
  }

  private async scrub(message: AuthMessage, owner: boolean): Promise<string> {
    if (!AUTH_PAYLOAD_PATTERN.test(message.text.trim()) || message.messageId === undefined) return "";
    try {
      await this.deleteMessage(message.chatId, message.messageId);
      return "";
    } catch {
      this.logger.warn?.("[telegram-auth] unable to delete sensitive auth message");
      return owner ? "Warning: the message could not be deleted. Remove it manually." : "";
    }
  }

  private async safeSend(chatId: AuthChatId, text: string, warning = ""): Promise<void> {
    const output = warning ? `${text}\n${warning}` : text;
    try { await this.sendMessage(chatId, output); } catch { this.logger.warn?.("[telegram-auth] unable to send auth update"); }
  }
}
