export type AuthProvider = "claude" | "codex";

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

  const args = match[1]?.trim().split(/\s+/) ?? [];
  if (args.length !== 1 && args.length !== 2) {
    return { kind: "rejected" };
  }

  const action = args[0]?.toLowerCase();
  if (action === "claude" && args.length === 1) {
    return { kind: "start", provider: "claude" };
  }
  if (action === "codex" && args.length === 1) {
    return { kind: "start", provider: "codex" };
  }
  if (action === "status" && args.length === 1) {
    return { kind: "status" };
  }
  if (action === "cancel" && args.length === 1) {
    return { kind: "cancel" };
  }
  if (action === "input" && args.length === 2 && isAuthCode(args[1])) {
    return { kind: "input", code: args[1] };
  }

  return { kind: "rejected" };
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
    this.verifyTimeoutSeconds =
      options.verifyTimeoutSeconds &&
      Number.isFinite(options.verifyTimeoutSeconds) &&
      options.verifyTimeoutSeconds > 0
        ? options.verifyTimeoutSeconds
        : DEFAULT_VERIFY_TIMEOUT_SECONDS;
    this.logger = options.logger;
    this.flowTtlSeconds =
      options.flowTtlSeconds && options.flowTtlSeconds > 0
        ? options.flowTtlSeconds
        : DEFAULT_FLOW_TTL_SECONDS;
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

    if (!command) {
      await this.sendSafely(message.chatId, "Unsupported authentication command.");
      return true;
    }

    switch (command.kind) {
      case "start":
        await this.startFlow(ownerId, command.provider, message.chatId);
        return true;
      case "status":
        await this.sendStatus(ownerId, message.chatId);
        return true;
      case "cancel":
        await this.cancelFlow(ownerId, message.chatId);
        return true;
      case "input":
        await this.writeCode(ownerId, command.code, message.chatId);
        return true;
      case "rejected":
        await this.sendSafely(
          message.chatId,
          "Unsupported authentication command. One-time codes must match the short-code format; tokens are not accepted.",
        );
        return true;
    }
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

  private async startFlow(
    ownerId: number,
    provider: AuthProvider,
    chatId: AuthChatId,
  ): Promise<void> {
    const key = flowKey(ownerId, provider);
    this.invalidatePendingVerifications(key);
    const previous = this.activeFlows.get(key);
    if (previous) {
      this.clearFlow(previous, true);
    }

    const args =
      provider === "claude"
        ? ["auth", "login", "--claudeai"]
        : ["login", "--device-auth"];
    const env = {
      PATH:
        process.env.PATH ??
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/home/node",
      CLAUDE_CONFIG_DIR: "/home/node/.claude",
      CODEX_HOME: "/home/node/.codex",
    };

    let pty: AuthPty;
    try {
      pty = this.spawnPty(provider, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: "/home/node",
        env,
      });
    } catch {
      await this.sendSafely(chatId, providerLabel(provider) + " authentication failed to start.");
      this.logger.error?.("[telegram-auth] failed to start provider process");
      return;
    }

    const flow: ActiveFlow = {
      ownerId,
      key,
      provider,
      chatId,
      pty,
      output: "",
      discoveryTail: "",
      timer: undefined,
      urlSent: false,
      codeSent: false,
      discoveryScheduled: false,
      invalidated: false,
    };
    this.activeFlows.set(key, flow);

    const dataSubscription = pty.onData((data) => {
      if (this.activeFlows.get(key) !== flow || flow.invalidated) {
        return;
      }
      this.captureDiscovery(flow, data);
      flow.output = appendOutput(flow.output, data);
      this.scheduleDiscovery(flow);
    });
    const exitSubscription = pty.onExit((event) => {
      void this.finishFlow(flow, event.exitCode);
    });
    flow.dataSubscription =
      dataSubscription && typeof dataSubscription === "object"
        ? dataSubscription
        : undefined;
    flow.exitSubscription =
      exitSubscription && typeof exitSubscription === "object"
        ? exitSubscription
        : undefined;
    flow.timer = this.clock.setTimeout(
      () => this.timeoutFlow(flow),
      this.flowTtlSeconds * 1000,
    );

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

    const lines = ["Continue authentication:"];
    if (flow.discoveredUrl && !flow.urlSent) {
      flow.urlSent = true;
      lines.push(flow.discoveredUrl);
    }
    if (flow.discoveredCode && !flow.codeSent) {
      flow.codeSent = true;
      lines.push("Device code: " + flow.discoveredCode);
    }
    if (lines.length === 1) {
      return;
    }
    void this.sendSafely(flow.chatId, lines.join("\n"));
  }

  private async sendStatus(ownerId: number, chatId: AuthChatId): Promise<void> {
    const activeProviders = [...this.activeFlows.values()]
      .filter((flow) => flow.ownerId === ownerId)
      .map((flow) => flow.provider)
      .sort();
    const lines: string[] = [];
    if (activeProviders.length > 0) {
      lines.push(
        "Active authentication flows: " +
          activeProviders.map((provider) => providerLabel(provider)).join(", ") +
          ".",
      );
    }
    for (const provider of ["claude", "codex"] as const) {
      const authenticated = await this.readAuthStatus(provider);
      lines.push(statusLine(provider, authenticated));
    }
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

    let timeoutHandle: unknown;
    let timerCreated = false;
    try {
      const verification = Promise.resolve(this.verifyAuth(provider));
      const timeout = new Promise<boolean>((resolve) => {
        timeoutHandle = this.clock.setTimeout(
          () => resolve(false),
          this.verifyTimeoutSeconds * 1000,
        );
        timerCreated = true;
      });
      return await Promise.race([verification, timeout]);
    } catch {
      this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
      return false;
    } finally {
      if (timerCreated) {
        this.clock.clearTimeout(timeoutHandle);
      }
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
