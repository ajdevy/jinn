export type AuthProvider = "claude" | "codex";

export type AuthMenuCommand = {
  command: string;
  description: string;
};

export const AUTH_MENU_COMMANDS: readonly AuthMenuCommand[] = [
  { command: "auth_claude", description: "Authenticate Claude" },
  { command: "auth_codex", description: "Authenticate Codex" },
  { command: "auth_status", description: "Show authentication status" },
  { command: "auth_cancel", description: "Cancel current authentication" },
];

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
  providerEnv?: Record<string, string>;
  verifyAuth?: (provider: AuthProvider) => Promise<boolean>;
  deleteSensitiveInputFromNonOwners?: boolean;
  verifyTimeoutSeconds?: number;
  logger: AuthLogger;
  flowTtlSeconds?: number;
}

const DEFAULT_FLOW_TTL_SECONDS = 600;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DISCOVERY_TAIL_BYTES = 4096;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const AUTH_SUBCOMMAND_PATTERN =
  "(?:claude|codex|status|cancel|input|token|access[-_]token|refresh[-_]token|oauth[-_]token|api[-_]key|apikey)";
const AUTH_PREFIX_PATTERN = new RegExp(
  `^\\/auth(?:_${AUTH_SUBCOMMAND_PATTERN}(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:[\\s=:]|$)`,
  "i",
);
const AUTH_PAYLOAD_PATTERN = new RegExp(
  `^\\/auth(?:_${AUTH_SUBCOMMAND_PATTERN}(?:@[A-Za-z0-9_]+)?|@[A-Za-z0-9_]+)?(?:\\s+\\S|[=:]\\s*\\S)`,
  "i",
);
const ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const PROVIDER_STATUS_CACHE_MS = 5_000;

type VerificationResult = {
  verified: boolean;
  timedOut: boolean;
  unavailable: boolean;
};

type ProviderStatusCacheEntry = {
  result: VerificationResult;
  expiresAt: number;
  generation: number;
};

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

const LEGACY_SINGLE_AUTH_COMMANDS: Readonly<Record<string, AuthCommand>> = {
  claude: { kind: "start", provider: "claude" },
  codex: { kind: "start", provider: "codex" },
  status: { kind: "status" },
  cancel: { kind: "cancel" },
};

export function parseAuthCommand(text: string): AuthCommand | null {
  const normalized = text.trim();
  if (!normalized || /\r|\n/.test(normalized)) {
    return null;
  }

  const menuCommand = parseAuthMenuCommand(normalized);
  if (menuCommand) {
    return menuCommand;
  }

  return parseLegacyAuthCommand(normalized);
}

function parseLegacyAuthCommand(normalized: string): AuthCommand | null {
  const match = normalized.match(/^\/auth(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  const args = match[1]?.trim().split(/\s+/) ?? [];
  if (args.length === 1) {
    return LEGACY_SINGLE_AUTH_COMMANDS[args[0].toLowerCase()] ?? { kind: "rejected" };
  }
  if (args.length === 2) {
    return parseLegacyInputCommand(args);
  }

  return { kind: "rejected" };
}

function parseLegacyInputCommand(args: string[]): AuthCommand {
  return args[0].toLowerCase() === "input" && isAuthCode(args[1])
    ? { kind: "input", code: args[1] }
    : { kind: "rejected" };
}

function parseAuthMenuCommand(normalized: string): AuthCommand | null {
  const menuInputMatch = normalized.match(
    /^\/auth_input(?:@[A-Za-z0-9_]+)?(?:\s+|[=:]\s*)(\S+)$/i,
  );
  if (menuInputMatch) {
    return isAuthCode(menuInputMatch[1])
      ? { kind: "input", code: menuInputMatch[1] }
      : { kind: "rejected" };
  }
  if (/^\/auth_input(?:@[A-Za-z0-9_]+)?$/i.test(normalized)) {
    return { kind: "rejected" };
  }

  if (
    /^\/auth_(?:token|access[-_]token|refresh[-_]token|oauth[-_]token|api[-_]key|apikey)(?:@[A-Za-z0-9_]+)?(?:\s+|[=:])/i.test(
      normalized,
    )
  ) {
    return { kind: "rejected" };
  }

  const menuMatch = normalized.match(
    /^\/auth_(claude|codex|status|cancel)(?:@[A-Za-z0-9_]+)?$/i,
  );
  if (menuMatch) {
    const menuAction = menuMatch[1].toLowerCase();
    if (menuAction === "claude" || menuAction === "codex") {
      return { kind: "start", provider: menuAction };
    }
    if (menuAction === "status") {
      return { kind: "status" };
    }
    return { kind: "cancel" };
  }
  return null;
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
  private readonly providerEnv: Record<string, string>;
  private readonly verifyAuth: AuthFlowManagerOptions["verifyAuth"];
  private readonly deleteSensitiveInputFromNonOwners: boolean;
  private readonly verifyTimeoutSeconds: number;
  private readonly logger: AuthLogger;
  private readonly flowTtlSeconds: number;
  private readonly activeFlows = new Map<FlowKey, ActiveFlow>();
  private readonly pendingVerifications = new Map<FlowKey, ActiveFlow>();
  private readonly providerStatusCache = new Map<
    AuthProvider,
    ProviderStatusCacheEntry
  >();
  private readonly providerStatusInFlight = new Map<
    AuthProvider,
    Promise<VerificationResult>
  >();
  private readonly providerStatusGeneration = new Map<AuthProvider, number>();

  constructor(options: AuthFlowManagerOptions) {
    this.ownerUserIds = new Set(options.ownerUserIds);
    this.clock = options.clock ?? defaultClock;
    this.send = options.send;
    this.deleteMessage = options.deleteMessage;
    this.spawnPty = options.spawnPty;
    this.providerEnv = options.providerEnv ?? {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/home/node",
      CLAUDE_CONFIG_DIR: "/home/node/.claude",
      CODEX_HOME: "/home/node/.codex",
    };
    this.verifyAuth = options.verifyAuth;
    this.deleteSensitiveInputFromNonOwners =
      options.deleteSensitiveInputFromNonOwners === true;
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
    const deletionWarning = await this.scrubAuthPayload(message, command, ownerId);

    if (ownerId === null) {
      return true;
    }

    if (message.chatType !== "private") {
      await this.sendSafely(
        message.chatId,
        "Authentication commands are available only in a private chat." +
          (deletionWarning ? "\n" + deletionWarning : ""),
      );
      return true;
    }

    if (!command) {
      await this.sendSafely(
        message.chatId,
        "Unsupported authentication command." +
          (deletionWarning ? "\n" + deletionWarning : ""),
      );
      return true;
    }

    return this.dispatchAuthCommand(ownerId, message, command, deletionWarning);
  }

  private async scrubAuthPayload(
    message: AuthMessage,
    command: AuthCommand | null,
    ownerId: number | null,
  ): Promise<string> {
    const rawText = message.text.trim();
    const isBareCommand =
      command?.kind === "start" ||
      command?.kind === "status" ||
      command?.kind === "cancel";
    if (!this.shouldScrubAuthPayload(rawText, isBareCommand, ownerId)) {
      return "";
    }
    return (await this.deleteMessageSafely(message))
      ? ""
      : "Warning: the message could not be deleted. Remove it manually.";
  }

  private shouldScrubAuthPayload(
    rawText: string,
    isBareCommand: boolean,
    ownerId: number | null,
  ): boolean {
    return (
      AUTH_PAYLOAD_PATTERN.test(rawText) &&
      !isBareCommand &&
      (ownerId !== null || this.deleteSensitiveInputFromNonOwners)
    );
  }

  private async dispatchAuthCommand(
    ownerId: number,
    message: AuthMessage,
    command: AuthCommand,
    deletionWarning: string,
  ): Promise<boolean> {
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
        if (deletionWarning) await this.sendSafely(message.chatId, deletionWarning);
        return true;
      case "rejected":
        await this.sendSafely(
          message.chatId,
          "Unsupported authentication command. One-time codes must match the short-code format; tokens are not accepted." +
            (deletionWarning ? "\n" + deletionWarning : ""),
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

    const pty = await this.spawnProviderPty(provider, chatId);
    if (!pty) {
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
    this.attachFlow(flow);

    await this.sendSafely(
      chatId,
      providerLabel(provider) +
        " authentication started. Follow the instructions below. If the CLI asks you to paste a code, send it with /auth_input <code> (4-32 chars, A-Z, 0-9, -).",
    );
  }

  private async spawnProviderPty(
    provider: AuthProvider,
    chatId: AuthChatId,
  ): Promise<AuthPty | null> {
    const args =
      provider === "claude"
        ? ["auth", "login", "--claudeai"]
        : ["login", "--device-auth"];
    try {
      return this.spawnPty(provider, args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: "/home/node",
        env: this.providerEnv,
      });
    } catch {
      await this.sendSafely(chatId, providerLabel(provider) + " authentication failed to start.");
      this.logger.error?.("[telegram-auth] failed to start provider process");
      return null;
    }
  }

  private attachFlow(flow: ActiveFlow): void {
    const { key, pty } = flow;
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
    const lines = this.discoveryMessageLines(flow);
    if (lines.length === 1) {
      return;
    }
    void this.sendSafely(flow.chatId, lines.join("\n"));
  }

  private discoveryMessageLines(flow: ActiveFlow): string[] {
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
    return lines;
  }

  private async sendStatus(ownerId: number, chatId: AuthChatId): Promise<void> {
    const activeStatus = this.activeStatusForOwner(ownerId);
    if (!this.verifyAuth) {
      await this.sendSafely(chatId, activeStatus);
      return;
    }

    const providersToCheck = ["claude", "codex"] as const;
    const needsStatusCheck = providersToCheck.some(
      (provider) => !this.hasFreshProviderStatus(provider),
    );
    if (needsStatusCheck) {
      await this.sendSafely(chatId, activeStatus + "\nChecking authentication status...");
    }
    const providerStatuses = await Promise.all(
      providersToCheck.map(async (provider) => {
        const verification = await this.getProviderStatus(provider);
      const status = verification.verified
        ? "authenticated"
        : verification.timedOut
          ? "verification timed out"
          : verification.unavailable
            ? "status unavailable"
            : "not authenticated";
        return `${providerLabel(provider)}: ${status}.`;
      }),
    );
    await this.sendSafely(
      chatId,
      this.activeStatusForOwner(ownerId) + "\n" + providerStatuses.join("\n"),
    );
  }

  private activeStatusForOwner(ownerId: number): string {
    const providers = [...this.activeFlows.values()]
      .filter((flow) => flow.ownerId === ownerId)
      .map((flow) => flow.provider)
      .sort();
    return providers.length === 0
      ? "No authentication flow is active."
      : "Active authentication flows: " +
          providers.map((provider) => providerLabel(provider)).join(", ") +
          ".";
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
    this.providerStatusInFlight.delete(flow.provider);
    const verificationGeneration = this.beginProviderStatusVerification(flow.provider);
    const verificationPromise = this.registerProviderStatusVerification(
      flow.provider,
      verificationGeneration,
    );

    let verification: VerificationResult = {
      verified: false,
      timedOut: false,
      unavailable: false,
    };
    try {
      verification = await verificationPromise;
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

    this.cacheProviderStatus(flow.provider, verification, verificationGeneration);
    await this.sendSafely(chatId, await this.describeFlowResult(flow, verification));
  }

  private async describeFlowResult(
    flow: ActiveFlow,
    verification: VerificationResult,
  ): Promise<string> {
    const provider = providerLabel(flow.provider);
    let result = provider + " authentication failed.";
    if (verification.verified) {
      result = provider + " authentication succeeded: authenticated.";
      if (flow.provider === "claude") {
        const codexVerification = await this.getProviderStatus("codex");
        const codexAuthenticated = codexVerification.verified;
        const codexFlowKey = flowKey(flow.ownerId, "codex");
        const codexFlowActive =
          this.activeFlows.has(codexFlowKey) ||
          this.pendingVerifications.has(codexFlowKey);
        if (
          !codexAuthenticated &&
          !codexVerification.timedOut &&
          !codexVerification.unavailable &&
          !codexFlowActive
        ) {
          result += "\nNext: authenticate Codex with /auth_codex.";
        }
      }
    } else if (verification.timedOut) {
      result =
        provider +
        " authentication verification timed out. Try again with /auth_" +
        flow.provider +
        ".";
    } else if (verification.unavailable) {
      result =
        provider +
        " authentication could not be verified. Check the provider CLI and try again with /auth_" +
        flow.provider +
        ".";
    }
    return result;
  }

  private async verifyWithTimeout(
    provider: AuthProvider,
  ): Promise<VerificationResult> {
    if (!this.verifyAuth) {
      return { verified: false, timedOut: false, unavailable: false };
    }

    let timeoutHandle: unknown;
    let timerCreated = false;
    try {
      const verification = Promise.resolve()
        .then(() => this.verifyAuth!(provider))
        .then(
          (verified) => ({ verified, timedOut: false, unavailable: false }),
          (error: unknown) => {
            this.logger.warn?.(
              "[telegram-auth] post-exit authentication verification failed",
            );
            const timedOut =
              typeof error === "object" &&
              error !== null &&
              (error as { timedOut?: unknown }).timedOut === true;
            return {
              verified: false,
              timedOut,
              unavailable: !timedOut,
            };
          },
        );
      const timeout = new Promise<VerificationResult>((resolve) => {
        timeoutHandle = this.clock.setTimeout(
          () => resolve({ verified: false, timedOut: true, unavailable: false }),
          this.verifyTimeoutSeconds * 1000,
        );
        timerCreated = true;
      });
      return await Promise.race([verification, timeout]);
    } catch {
      this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
      return { verified: false, timedOut: false, unavailable: true };
    } finally {
      if (timerCreated) {
        this.clock.clearTimeout(timeoutHandle);
      }
    }
  }

  private getProviderStatus(provider: AuthProvider): Promise<VerificationResult> {
    const now = this.clock.now?.() ?? Date.now();
    const cached = this.providerStatusCache.get(provider);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached.result);
    }

    const inFlight = this.providerStatusInFlight.get(provider);
    if (inFlight) {
      return inFlight;
    }

    const generation = this.beginProviderStatusVerification(provider);
    return this.registerProviderStatusVerification(provider, generation);
  }

  private registerProviderStatusVerification(
    provider: AuthProvider,
    generation: number,
  ): Promise<VerificationResult> {
    const verification = this.verifyWithTimeout(provider);
    this.providerStatusInFlight.set(provider, verification);
    void verification
      .then(
        (result) => this.cacheProviderStatus(provider, result, generation),
        () => undefined,
      )
      .finally(() => {
        if (this.providerStatusInFlight.get(provider) === verification) {
          this.providerStatusInFlight.delete(provider);
        }
      });
    return verification;
  }

  private cacheProviderStatus(
    provider: AuthProvider,
    result: VerificationResult,
    generation: number,
  ): void {
    const cached = this.providerStatusCache.get(provider);
    if (cached && cached.generation > generation) {
      return;
    }
    this.providerStatusCache.set(provider, {
      result,
      expiresAt: (this.clock.now?.() ?? Date.now()) + PROVIDER_STATUS_CACHE_MS,
      generation,
    });
  }

  private beginProviderStatusVerification(provider: AuthProvider): number {
    const generation = (this.providerStatusGeneration.get(provider) ?? 0) + 1;
    this.providerStatusGeneration.set(provider, generation);
    return generation;
  }

  private hasFreshProviderStatus(provider: AuthProvider): boolean {
    const cached = this.providerStatusCache.get(provider);
    return Boolean(cached && cached.expiresAt > (this.clock.now?.() ?? Date.now()));
  }

  private timeoutFlow(flow: ActiveFlow): void {
    if (this.activeFlows.get(flow.key) !== flow || flow.invalidated) {
      return;
    }
    const chatId = flow.chatId;
    this.clearFlow(flow, true);
    void this.sendSafely(
      chatId,
      "Authentication timed out. Try again with /auth_" +
        flow.provider +
        ".",
    );
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

  private async deleteMessageSafely(message: AuthMessage): Promise<boolean> {
    if (message.messageId === undefined) {
      return true;
    }
    try {
      await this.deleteMessage(message.chatId, message.messageId);
      return true;
    } catch {
      this.logger.warn?.("[telegram-auth] unable to delete sensitive auth message");
      return false;
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
