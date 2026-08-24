import {
  AUTH_PROVIDERS,
  type ActiveFlow,
  type AuthChatId,
  type AuthFlowManagerOptions,
  type AuthLogger,
  type AuthProvider,
  type AuthPty,
  type AuthClock,
  appendBoundedText,
  appendOutput,
  createFlow,
  discoveryLines,
  extractDiscovery,
  flowHasActiveDiscovery,
  flowKey,
  providerArgs,
  providerEnv,
  statusLines,
  subscriptionObject,
  validDurationSeconds,
} from "./auth-flow-support.js";

const DEFAULT_FLOW_TTL_SECONDS = 600;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 30;
const MAX_DISCOVERY_TAIL_BYTES = 4096;

type FlowKey = string;

type LifecycleOptions = Pick<
  AuthFlowManagerOptions,
  "clock" | "send" | "spawnPty" | "verifyAuth" | "getAuthStatus" | "logger"
> & {
  flowTtlSeconds?: number;
  verifyTimeoutSeconds?: number;
};

export class AuthFlowLifecycle {
  private readonly clock: AuthClock;
  private readonly send: LifecycleOptions["send"];
  private readonly spawnPty: LifecycleOptions["spawnPty"];
  private readonly verifyAuth: LifecycleOptions["verifyAuth"];
  private readonly getAuthStatus: LifecycleOptions["getAuthStatus"];
  private readonly verifyTimeoutSeconds: number;
  private readonly flowTtlSeconds: number;
  private readonly logger: AuthLogger;
  private readonly activeFlows = new Map<FlowKey, ActiveFlow>();
  private readonly pendingVerifications = new Map<FlowKey, ActiveFlow>();

  constructor(options: LifecycleOptions) {
    this.clock = options.clock;
    this.send = options.send;
    this.spawnPty = options.spawnPty;
    this.verifyAuth = options.verifyAuth;
    this.getAuthStatus = options.getAuthStatus;
    this.logger = options.logger;
    this.verifyTimeoutSeconds = validDurationSeconds(
      options.verifyTimeoutSeconds,
      DEFAULT_VERIFY_TIMEOUT_SECONDS,
    );
    this.flowTtlSeconds = validDurationSeconds(
      options.flowTtlSeconds,
      DEFAULT_FLOW_TTL_SECONDS,
    );
  }
  async start(ownerId: number, provider: AuthProvider, chatId: AuthChatId): Promise<void> {
    const key = flowKey(ownerId, provider);
    this.invalidatePendingVerifications(key);
    this.clearPreviousFlow(key);
    const pty = await this.spawnProviderPty(provider, chatId);
    if (!pty) return;
    const flow = createFlow({ ownerId, key, provider, chatId, pty });
    this.activeFlows.set(key, flow);
    this.attachFlowHandlers(flow);
    await this.sendSafely(
      chatId,
      this.label(provider) + " authentication started. Follow the instructions below.",
    );
  }
  async status(ownerId: number): Promise<string> {
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
    return statusLines(activeProviders, statuses).join("\n");
  }
  cancel(ownerId: number): "none" | "cancelled" {
    const activeFlows = [...this.activeFlows.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    const pending = [...this.pendingVerifications.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    if (activeFlows.length === 0 && pending.length === 0) return "none";
    for (const flow of activeFlows) this.clearFlow(flow, true);
    this.invalidatePendingVerifications(undefined, ownerId);
    return "cancelled";
  }
  input(ownerId: number, code: string): "none" | "ambiguous" | "written" | "failed" {
    const flows = [...this.activeFlows.values()].filter(
      (flow) => flow.ownerId === ownerId,
    );
    if (flows.length === 0) return "none";
    if (flows.length > 1) return "ambiguous";
    try {
      flows[0].pty.write(code + "\r");
      return "written";
    } catch {
      this.logger.warn?.("[telegram-auth] failed to write authentication input");
      return "failed";
    }
  }
  stop(): void {
    for (const flow of this.activeFlows.values()) this.clearFlow(flow, true);
    this.invalidatePendingVerifications();
  }
  private label(provider: AuthProvider): string {
    return provider === "claude" ? "Claude" : "Codex";
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
      await this.sendSafely(chatId, this.label(provider) + " authentication failed to start.");
      this.logger.error?.("[telegram-auth] failed to start provider process");
      return null;
    }
  }
  private clearPreviousFlow(key: FlowKey): void {
    const previous = this.activeFlows.get(key);
    if (previous) this.clearFlow(previous, true);
  }
  private attachFlowHandlers(flow: ActiveFlow): void {
    flow.dataSubscription = subscriptionObject(
      flow.pty.onData((data) => {
        if (!this.isActiveFlow(flow)) return;
        this.captureDiscovery(flow, data);
        flow.output = appendOutput(flow.output, data);
        this.flushDiscovery(flow);
      }),
    );
    flow.exitSubscription = subscriptionObject(
      flow.pty.onExit((event) => void this.finishFlow(flow, event.exitCode)),
    );
    flow.timer = this.clock.setTimeout(
      () => this.timeoutFlow(flow),
      this.flowTtlSeconds * 1000,
    );
  }
  private isActiveFlow(flow: ActiveFlow): boolean {
    return this.activeFlows.get(flow.key) === flow && !flow.invalidated;
  }
  private captureDiscovery(flow: ActiveFlow, data: string): void {
    const discovery = extractDiscovery(flow.discoveryTail + data);
    if (discovery.url && !flow.discoveredUrl) flow.discoveredUrl = discovery.url;
    if (discovery.code && !flow.discoveredCode) flow.discoveredCode = discovery.code;
    flow.discoveryTail = appendBoundedText(
      flow.discoveryTail,
      data,
      MAX_DISCOVERY_TAIL_BYTES,
    );
  }
  private flushDiscovery(flow: ActiveFlow): void {
    if (flow.invalidated) return;
    const discovery = extractDiscovery(flow.output);
    if (discovery.url && !flow.discoveredUrl) flow.discoveredUrl = discovery.url;
    if (discovery.code && !flow.discoveredCode) flow.discoveredCode = discovery.code;
    if (!flowHasActiveDiscovery(flow)) return;
    void this.sendSafely(flow.chatId, discoveryLines(flow).join("\n"));
  }
  private async finishFlow(flow: ActiveFlow, exitCode: number): Promise<void> {
    if (!this.isActiveFlow(flow)) return;
    this.flushDiscovery(flow);
    const provider = this.label(flow.provider);
    if (exitCode !== 0) {
      this.clearFlow(flow, false);
      await this.sendSafely(flow.chatId, provider + " authentication failed.");
      return;
    }
    this.detachFlow(flow, false);
    this.pendingVerifications.set(flow.key, flow);
    let verified = false;
    try {
      verified = await this.verifyWithTimeout(flow.provider);
    } finally {
      if (this.pendingVerifications.get(flow.key) === flow) {
        this.pendingVerifications.delete(flow.key);
      }
    }
    if (flow.invalidated) return;
    await this.sendSafely(
      flow.chatId,
      verified ? provider + " authentication succeeded: authenticated." : provider + " authentication failed.",
    );
  }
  private async verifyWithTimeout(provider: AuthProvider): Promise<boolean> {
    if (!this.verifyAuth) return false;
    return this.booleanWithTimeout(
      () => Promise.resolve(this.verifyAuth?.(provider) ?? false),
      "[telegram-auth] post-exit authentication verification timed out",
    );
  }
  private async readAuthStatusWithTimeout(provider: AuthProvider): Promise<boolean> {
    return this.booleanWithTimeout(
      () => this.readAuthStatus(provider),
      "[telegram-auth] authentication status check timed out",
    );
  }
  private async readAuthStatus(provider: AuthProvider): Promise<boolean> {
    if (!this.getAuthStatus) return false;
    try {
      return await this.getAuthStatus(provider);
    } catch {
      this.logger.warn?.("[telegram-auth] authentication status check failed");
      return false;
    }
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
      if (timeoutHandle !== undefined) this.clock.clearTimeout(timeoutHandle);
    }
  }
  private timeoutFlow(flow: ActiveFlow): void {
    if (!this.isActiveFlow(flow)) return;
    const chatId = flow.chatId;
    this.clearFlow(flow, true);
    void this.sendSafely(chatId, "Authentication timed out.");
  }
  private invalidatePendingVerifications(key?: FlowKey, ownerId?: number): void {
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
    if (this.activeFlows.get(flow.key) !== flow) return;
    this.activeFlows.delete(flow.key);
    if (invalidate) flow.invalidated = true;
    if (flow.timer !== undefined) {
      this.clock.clearTimeout(flow.timer);
      flow.timer = undefined;
    }
    flow.dataSubscription?.dispose?.();
    flow.exitSubscription?.dispose?.();
    flow.output = "";
    flow.discoveryTail = "";
  }
  private clearFlow(flow: ActiveFlow, kill: boolean): void {
    if (this.activeFlows.get(flow.key) !== flow) return;
    this.detachFlow(flow, true);
    if (!kill) return;
    try {
      flow.pty.kill();
    } catch {
      this.logger.warn?.("[telegram-auth] failed to stop provider process");
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
