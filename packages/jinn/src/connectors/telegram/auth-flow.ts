export type AuthProvider = "claude" | "codex";
const AUTH_PROVIDERS = ["claude", "codex"] as const satisfies readonly AuthProvider[];

export type AuthCommand =
  | { kind: "start"; provider: AuthProvider }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "input"; code: string }
  | { kind: "rejected" };

export type AuthChatId = number | string;

export interface AuthMessage {
  userId: number | string;
  chatType: string;
  chatId: AuthChatId;
  messageId?: number | string;
  text: string;
}

export interface AuthPty {
  write(data: string): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): { dispose?: () => void } | void;
  onExit(
    handler: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose?: () => void } | void;
}

export interface AuthClock {
  now?: () => number;
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuthLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface AuthSpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (
  file: string,
  args: string[],
  options: AuthSpawnOptions,
) => AuthPty;

export interface AuthFlowManagerOptions {
  ownerUserIds: readonly number[];
  clock: AuthClock;
  send: (chatId: AuthChatId, text: string) => void | Promise<void>;
  deleteMessage: (
    chatId: AuthChatId,
    messageId: number | string,
  ) => void | Promise<void>;
  spawnPty: SpawnPty;
  verifyAuth?: (provider: AuthProvider) => Promise<boolean>;
  getAuthStatus?: (provider: AuthProvider) => Promise<boolean>;
  verifyTimeoutSeconds?: number;
  logger: AuthLogger;
  flowTtlSeconds?: number;
}

const DEFAULT_FLOW_TTL_SECONDS = 600;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DISCOVERY_TAIL_BYTES = 4096;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const AUTH_PREFIX_PATTERN = /^\/auth(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const SENSITIVE_INPUT_PATTERN =
  /^\/auth(?:@[A-Za-z0-9_]+)?\s+(?:input|token|access[-_]token|refresh[-_]token|oauth[-_]token|api[-_]key|apikey)\b/i;
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const defaultClock: AuthClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isAuthCode(value: string): boolean {
  return CODE_PATTERN.test(value);
}

function providerLabel(provider: AuthProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function parseAuthCommand(text: string): AuthCommand | null {
  const normalized = text.trim();
  if (!normalized || /\r|\n/.test(normalized)) {
    return null;
  }

  const match = normalized.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  return parseAuthArgs(match[1]?.trim().split(/\s+/) ?? []);
}

function parseAuthArgs(args: string[]): AuthCommand {
  if (args.length === 1) {
    return parseSingleArgCommand(args[0].toLowerCase());
  }
  if (args.length === 2 && args[0].toLowerCase() === "input" && isAuthCode(args[1])) {
    return { kind: "input", code: args[1] };
  }
  return { kind: "rejected" };
}

function parseSingleArgCommand(action: string): AuthCommand {
  switch (action) {
    case "claude":
      return { kind: "start", provider: "claude" };
    case "codex":
      return { kind: "start", provider: "codex" };
    case "status":
      return { kind: "status" };
    case "cancel":
      return { kind: "cancel" };
    default:
      return { kind: "rejected" };
  }
}

function dispatchableCommand(command: AuthCommand | null): command is AuthCommand {
  return command !== null;
}

function providerArgs(provider: AuthProvider): string[] {
  return provider === "claude"
    ? ["auth", "login", "--claudeai"]
    : ["login", "--device-auth"];
}

function providerEnv(): Record<string, string> {
  return {
    PATH:
      process.env.PATH ??
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/node",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
    CODEX_HOME: "/home/node/.codex",
  };
}

function flowHasActiveDiscovery(flow: ActiveFlow): boolean {
  return Boolean(
    (flow.discoveredUrl && !flow.urlSent) ||
      (flow.discoveredCode && !flow.codeSent),
  );
}

function discoveryLines(flow: ActiveFlow): string[] {
  const lines = ["Continue authentication:"];
  if (flow.discoveredUrl && !flow.urlSent) {
    flow.urlSent = true;
    lines.push(flow.discoveredUrl);
  }
  if (flow.discoveredCode && !flow.codeSent) {
    flow.codeSent = true;
    lines.push("Device code: " + flow.discoveredCode);
  }
  return lines;
}

function activeProviderStatusLine(providers: AuthProvider[]): string | null {
  if (providers.length === 0) {
    return null;
  }
  return (
    "Active authentication flows: " +
    providers.map((provider) => providerLabel(provider)).join(", ") +
    "."
  );
}

function validDurationSeconds(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function redactAuthOutput(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [TOKEN REDACTED]")
    .replace(
      /\b(?:access|refresh|oauth)[_-]?token\s*[:=]\s*[^\s,;]+/gi,
      "[TOKEN REDACTED]",
    )
    .replace(
      /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[TOKEN REDACTED]",
    )
    .replace(/\b[A-Z0-9][A-Z0-9-]{3,31}\b/g, "[CODE REDACTED]");
}

function extractDiscovery(text: string): { url?: string; code?: string } {
  const normalized = text.replace(ANSI_PATTERN, "");
  const urlMatch = normalized.match(/https:\/\/[^\s"'<>\x60]+/i);
  const url = urlMatch?.[0]?.replace(/[.,!?;:)\]}]+$/g, "");

  const codeMatch =
    normalized.match(
      /(?:device\s+code|user\s+code|code)\s*[:=]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i,
    ) ?? normalized.match(/(?:device_code|user_code)=([A-Z0-9][A-Z0-9-]{3,31})\b/i);
  const code = codeMatch?.[1] && isAuthCode(codeMatch[1]) ? codeMatch[1] : undefined;

  return { url, code };
}

function appendBoundedText(current: string, data: string, maxBytes: number): string {
  const bytes = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(data, "utf8")]);
  const kept =
    bytes.length > maxBytes
      ? bytes.subarray(bytes.length - maxBytes)
      : bytes;
  return kept.toString("utf8");
}

function appendOutput(current: string, data: string): string {
  return appendBoundedText(current, data, MAX_OUTPUT_BYTES);
}

type FlowKey = string;

function flowKey(ownerId: number, provider: AuthProvider): FlowKey {
  return ownerId + ":" + provider;
}

interface ActiveFlow {
  ownerId: number;
  key: FlowKey;
  provider: AuthProvider;
  chatId: AuthChatId;
  pty: AuthPty;
  output: string;
  discoveryTail: string;
  timer: unknown;
  discoveredUrl?: string;
  discoveredCode?: string;
  urlSent: boolean;
  codeSent: boolean;
  discoveryScheduled: boolean;
  invalidated: boolean;
  dataSubscription?: { dispose?: () => void };
  exitSubscription?: { dispose?: () => void };
}

function createFlow(options: {
  ownerId: number;
  key: FlowKey;
  provider: AuthProvider;
  chatId: AuthChatId;
  pty: AuthPty;
}): ActiveFlow {
  return {
    ...options,
    output: "",
    discoveryTail: "",
    timer: undefined,
    urlSent: false,
    codeSent: false,
    discoveryScheduled: false,
    invalidated: false,
  };
}

function subscriptionObject(
  subscription: { dispose?: () => void } | void,
): { dispose?: () => void } | undefined {
  return subscription && typeof subscription === "object"
    ? subscription
    : undefined;
}

function statusLines(
  activeProviders: AuthProvider[],
  statuses: Array<{ provider: AuthProvider; authenticated: boolean }>,
): string[] {
  const activeLine = activeProviderStatusLine(activeProviders);
  const lines = activeLine ? [activeLine] : [];
  lines.push(
    ...statuses.map(({ provider, authenticated }) =>
      statusLine(provider, authenticated),
    ),
  );
  return lines;
}

export class AuthFlowManager {
  private readonly ownerUserIds: ReadonlySet<number>;
  private readonly clock: AuthClock;
  private readonly send: AuthFlowManagerOptions["send"];
  private readonly deleteMessage: AuthFlowManagerOptions["deleteMessage"];
  private readonly spawnPty: SpawnPty;
  private readonly verifyAuth: AuthFlowManagerOptions["verifyAuth"];
  private readonly getAuthStatus: AuthFlowManagerOptions["getAuthStatus"];
  private readonly verifyTimeoutSeconds: number;
  private readonly logger: AuthLogger;
  private readonly flowTtlSeconds: number;
  private readonly activeFlows = new Map<FlowKey, ActiveFlow>();
  private readonly pendingVerifications = new Map<FlowKey, ActiveFlow>();

  constructor(options: AuthFlowManagerOptions) {
    this.ownerUserIds = new Set(options.ownerUserIds);
    this.clock = options.clock ?? defaultClock;
    this.send = options.send;
    this.deleteMessage = options.deleteMessage;
    this.spawnPty = options.spawnPty;
    this.verifyAuth = options.verifyAuth;
    this.getAuthStatus = options.getAuthStatus;
    this.verifyTimeoutSeconds = validDurationSeconds(
      options.verifyTimeoutSeconds,
      DEFAULT_VERIFY_TIMEOUT_SECONDS,
    );
    this.logger = options.logger;
    this.flowTtlSeconds = validDurationSeconds(
      options.flowTtlSeconds,
      DEFAULT_FLOW_TTL_SECONDS,
    );
  }

  async handleMessage(message: AuthMessage): Promise<boolean> {
    const rawText = message.text.trim();
    if (!AUTH_PREFIX_PATTERN.test(rawText)) {
      return false;
    }

    const command = parseAuthCommand(message.text);
    const ownerId = this.canonicalOwnerId(message.userId);
    if (ownerId === null) {
      return true;
    }

    if (SENSITIVE_INPUT_PATTERN.test(rawText)) {
      await this.deleteMessageSafely(message);
    }

    if (message.chatType !== "private") {
      await this.sendSafely(
        message.chatId,
        "Authentication commands are available only in a private chat.",
      );
      return true;
    }

    if (!dispatchableCommand(command)) {
      await this.sendSafely(message.chatId, "Unsupported authentication command.");
      return true;
    }

    await this.dispatchCommand(ownerId, command, message.chatId);
    return true;
  }

  stop(): void {
    for (const flow of this.activeFlows.values()) {
      this.clearFlow(flow, true);
    }
    this.invalidatePendingVerifications();
  }

  private canonicalOwnerId(userId: number | string): number | null {
    const numericId = typeof userId === "number" ? userId : Number(userId);
    return Number.isSafeInteger(numericId) && this.ownerUserIds.has(numericId)
      ? numericId
      : null;
  }

  private async dispatchCommand(
    ownerId: number,
    command: AuthCommand,
    chatId: AuthChatId,
  ): Promise<void> {
    switch (command.kind) {
      case "start":
        await this.startFlow(ownerId, command.provider, chatId);
        return;
      case "status":
        await this.sendStatus(ownerId, chatId);
        return;
      case "cancel":
        await this.cancelFlow(ownerId, chatId);
        return;
      case "input":
        await this.writeCode(ownerId, command.code, chatId);
        return;
      case "rejected":
        await this.sendRejectedCommand(chatId);
    }
  }

  private async sendRejectedCommand(chatId: AuthChatId): Promise<void> {
    await this.sendSafely(
      chatId,
      "Unsupported authentication command. One-time codes must match the short-code format; tokens are not accepted.",
    );
  }

  private clearPreviousFlow(key: FlowKey): void {
    const previous = this.activeFlows.get(key);
    if (previous) {
      this.clearFlow(previous, true);
    }
  }

  private async spawnProviderPty(
    provider: AuthProvider,
    chatId: AuthChatId,
  ): Promise<AuthPty | null> {
    try {
      return this.spawnPty(provider, providerArgs(provider), {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: "/home/node",
        env: providerEnv(),
      });
    } catch {
      await this.sendSafely(chatId, providerLabel(provider) + " authentication failed to start.");
      this.logger.error?.("[telegram-auth] failed to start provider process");
      return null;
    }
  }

  private attachFlowHandlers(flow: ActiveFlow): void {
    const dataSubscription = flow.pty.onData((data) => {
      if (!this.isActiveFlow(flow)) {
        return;
      }
      this.captureDiscovery(flow, data);
      flow.output = appendOutput(flow.output, data);
      this.scheduleDiscovery(flow);
    });
    const exitSubscription = flow.pty.onExit((event) => {
      void this.finishFlow(flow, event.exitCode);
    });
    flow.dataSubscription = subscriptionObject(dataSubscription);
    flow.exitSubscription = subscriptionObject(exitSubscription);
    flow.timer = this.clock.setTimeout(
      () => this.timeoutFlow(flow),
      this.flowTtlSeconds * 1000,
    );
  }

  private isActiveFlow(flow: ActiveFlow): boolean {
    return this.activeFlows.get(flow.key) === flow && !flow.invalidated;
  }

  private async startFlow(
    ownerId: number,
    provider: AuthProvider,
    chatId: AuthChatId,
  ): Promise<void> {
    const key = flowKey(ownerId, provider);
    this.invalidatePendingVerifications(key);
    this.clearPreviousFlow(key);

    const pty = await this.spawnProviderPty(provider, chatId);
    if (!pty) {
      return;
    }

    const flow = createFlow({ ownerId, key, provider, chatId, pty });
    this.activeFlows.set(key, flow);
    this.attachFlowHandlers(flow);
    await this.sendSafely(
      chatId,
      providerLabel(provider) + " authentication started. Follow the instructions below.",
    );
  }

  private captureDiscovery(flow: ActiveFlow, data: string): void {
    const discovery = extractDiscovery(flow.discoveryTail + data);
    if (discovery.url && !flow.discoveredUrl) {
      flow.discoveredUrl = discovery.url;
    }
    if (discovery.code && !flow.discoveredCode) {
      flow.discoveredCode = discovery.code;
    }
    flow.discoveryTail = appendBoundedText(
      flow.discoveryTail,
      data,
      MAX_DISCOVERY_TAIL_BYTES,
    );
  }

  private scheduleDiscovery(flow: ActiveFlow): void {
    if (this.activeFlows.get(flow.key) !== flow || flow.invalidated) {
      return;
    }
    this.flushDiscovery(flow);
  }

  private flushDiscovery(flow: ActiveFlow): void {
    if (flow.invalidated) {
      return;
    }

    flow.discoveryScheduled = false;
    const discovery = extractDiscovery(flow.output);
    if (discovery.url && !flow.discoveredUrl) {
      flow.discoveredUrl = discovery.url;
    }
    if (discovery.code && !flow.discoveredCode) {
      flow.discoveredCode = discovery.code;
    }

    if (!flowHasActiveDiscovery(flow)) {
      return;
    }
    void this.sendSafely(flow.chatId, discoveryLines(flow).join("\n"));
  }

  private async sendStatus(ownerId: number, chatId: AuthChatId): Promise<void> {
    const activeProviders = [...this.activeFlows.values()]
      .filter((flow) => flow.ownerId === ownerId)
      .map((flow) => flow.provider)
      .sort();
    const statuses = await Promise.all(
      AUTH_PROVIDERS.map(async (provider) => ({
        provider,
        authenticated: await this.readAuthStatusWithTimeout(provider),
      })),
    );
    const lines = statusLines(activeProviders, statuses);
    await this.sendSafely(chatId, lines.join("\n"));
  }

  private async cancelFlow(ownerId: number, chatId: AuthChatId): Promise<void> {
    const activeFlows = [...this.activeFlows.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    const pendingVerifications = [...this.pendingVerifications.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    if (activeFlows.length === 0 && pendingVerifications.length === 0) {
      await this.sendSafely(chatId, "No authentication flow is active.");
      return;
    }

    for (const flow of activeFlows) {
      this.clearFlow(flow, true);
    }
    this.invalidatePendingVerifications(undefined, ownerId);
    await this.sendSafely(chatId, "Authentication cancelled.");
  }

  private async writeCode(
    ownerId: number,
    code: string,
    chatId: AuthChatId,
  ): Promise<void> {
    const flows = [...this.activeFlows.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    if (flows.length === 0) {
      await this.sendSafely(chatId, "No authentication flow is active.");
      return;
    }
    if (flows.length > 1) {
      await this.sendSafely(
        chatId,
        "Authentication input is ambiguous while multiple providers are active.",
      );
      return;
    }

    try {
      flows[0].pty.write(code + "\r");
    } catch {
      this.logger.warn?.("[telegram-auth] failed to write authentication input");
      await this.sendSafely(chatId, "Authentication input failed.");
    }
  }

  private async finishFlow(flow: ActiveFlow, exitCode: number): Promise<void> {
    if (this.activeFlows.get(flow.key) !== flow || flow.invalidated) {
      return;
    }

    this.flushDiscovery(flow);
    const chatId = flow.chatId;
    const provider = providerLabel(flow.provider);
    if (exitCode !== 0) {
      this.clearFlow(flow, false);
      await this.sendSafely(chatId, provider + " authentication failed.");
      return;
    }

    this.detachFlow(flow, false);
    this.pendingVerifications.set(flow.key, flow);

    let verified = false;
    try {
      verified = await this.verifyWithTimeout(flow.provider);
    } catch {
      this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
    } finally {
      if (this.pendingVerifications.get(flow.key) === flow) {
        this.pendingVerifications.delete(flow.key);
      }
    }

    if (flow.invalidated) {
      return;
    }

    await this.sendSafely(
      chatId,
      verified
        ? provider + " authentication succeeded: authenticated."
        : provider + " authentication failed.",
    );
  }

  private async verifyWithTimeout(provider: AuthProvider): Promise<boolean> {
    if (!this.verifyAuth) {
      return false;
    }
    try {
      return await this.booleanWithTimeout(
        () => Promise.resolve(this.verifyAuth?.(provider) ?? false),
        "[telegram-auth] post-exit authentication verification timed out",
      );
    } catch {
      this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
      return false;
    }
  }

  private async readAuthStatus(provider: AuthProvider): Promise<boolean> {
    if (!this.getAuthStatus) {
      return false;
    }
    try {
      return await this.getAuthStatus(provider);
    } catch {
      this.logger.warn?.("[telegram-auth] authentication status check failed");
      return false;
    }
  }

  private async readAuthStatusWithTimeout(provider: AuthProvider): Promise<boolean> {
    return await this.booleanWithTimeout(
      () => this.readAuthStatus(provider),
      "[telegram-auth] authentication status check timed out",
    );
  }

  private async booleanWithTimeout(
    action: () => Promise<boolean>,
    timeoutLogMessage: string,
  ): Promise<boolean> {
    let timeoutHandle: unknown;
    try {
      const timeout = new Promise<boolean>((resolve) => {
        timeoutHandle = this.clock.setTimeout(() => {
          this.logger.warn?.(timeoutLogMessage);
          resolve(false);
        }, this.verifyTimeoutSeconds * 1000);
      });
      return await Promise.race([action(), timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.clock.clearTimeout(timeoutHandle);
      }
    }
  }

  private timeoutFlow(flow: ActiveFlow): void {
    if (this.activeFlows.get(flow.key) !== flow || flow.invalidated) {
      return;
    }
    const chatId = flow.chatId;
    this.clearFlow(flow, true);
    void this.sendSafely(chatId, "Authentication timed out.");
  }

  private invalidatePendingVerifications(
    key?: FlowKey,
    ownerId?: number,
  ): void {
    for (const [pendingKey, flow] of this.pendingVerifications) {
      if (
        (key === undefined || pendingKey === key) &&
        (ownerId === undefined || flow.ownerId === ownerId)
      ) {
        flow.invalidated = true;
        this.pendingVerifications.delete(pendingKey);
      }
    }
  }

  private detachFlow(flow: ActiveFlow, invalidate: boolean): void {
    if (this.activeFlows.get(flow.key) !== flow) {
      return;
    }

    this.activeFlows.delete(flow.key);
    if (invalidate) {
      flow.invalidated = true;
    }
    if (flow.timer !== undefined) {
      this.clock.clearTimeout(flow.timer);
      flow.timer = undefined;
    }
    flow.dataSubscription?.dispose?.();
    flow.exitSubscription?.dispose?.();
    flow.output = "";
    flow.discoveryTail = "";
    flow.discoveryScheduled = false;
  }

  private clearFlow(flow: ActiveFlow, kill: boolean): void {
    if (this.activeFlows.get(flow.key) !== flow) {
      return;
    }

    this.detachFlow(flow, true);
    if (kill) {
      try {
        flow.pty.kill();
      } catch {
        this.logger.warn?.("[telegram-auth] failed to stop provider process");
      }
    }
  }

  private async deleteMessageSafely(message: AuthMessage): Promise<void> {
    if (message.messageId === undefined) {
      return;
    }
    try {
      await this.deleteMessage(message.chatId, message.messageId);
    } catch {
      this.logger.debug?.("[telegram-auth] unable to delete sensitive auth message");
    }
  }

  private async sendSafely(chatId: AuthChatId, text: string): Promise<void> {
    try {
      await this.send(chatId, text);
    } catch {
      this.logger.warn?.("[telegram-auth] unable to send auth update");
    }
  }
}

function statusLine(provider: AuthProvider, authenticated: boolean): string {
  const label = providerLabel(provider);
  if (authenticated) {
    return label + " is authenticated.";
  }
  return label + " is not authenticated. Use /auth " + provider + " to sign in.";
}
