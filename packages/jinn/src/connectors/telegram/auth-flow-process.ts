import type {
  ActiveFlow,
  AuthChatId,
  AuthClock,
  AuthLogger,
  AuthPty,
  AuthProvider,
  SpawnPty,
  VerificationResult,
} from "./auth-flow-types.js";
import {
  appendOutput,
  DEFAULT_FLOW_TTL_SECONDS,
  discoveryMessageLines,
  flowKey,
  providerLabel,
  updateDiscovery,
} from "./auth-flow-parser.js";
import { ProviderStatusVerifier } from "./auth-flow-status.js";

export class AuthFlowProcessManager {
  private readonly clock: AuthClock;
  private readonly send: (chatId: AuthChatId, text: string) => void | Promise<void>;
  private readonly spawnPty: SpawnPty;
  private readonly verifier: ProviderStatusVerifier;
  private readonly logger: AuthLogger;
  private readonly ttlSeconds: number;
  private readonly active = new Map<string, ActiveFlow>();
  private readonly pending = new Map<string, ActiveFlow>();

  constructor(options: {
    clock: AuthClock;
    send: (chatId: AuthChatId, text: string) => void | Promise<void>;
    spawnPty: SpawnPty;
    verifier: ProviderStatusVerifier;
    logger: AuthLogger;
    flowTtlSeconds?: number;
  }) {
    this.clock = options.clock;
    this.send = options.send;
    this.spawnPty = options.spawnPty;
    this.verifier = options.verifier;
    this.logger = options.logger;
    this.ttlSeconds = options.flowTtlSeconds && options.flowTtlSeconds > 0 ? options.flowTtlSeconds : DEFAULT_FLOW_TTL_SECONDS;
  }

  async start(ownerId: number, provider: AuthProvider, chatId: AuthChatId, env: Record<string, string>): Promise<void> {
    const key = flowKey(ownerId, provider);
    this.invalidatePending(key);
    const previous = this.active.get(key);
    if (previous) this.clear(previous, true);
    let pty: AuthPty;
    try {
      pty = this.spawnPty(provider, provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"], {
        name: "xterm-256color", cols: 120, rows: 40, cwd: "/home/node", env,
      });
    } catch {
      await this.safeSend(chatId, providerLabel(provider) + " authentication failed to start.");
      this.logger.error?.("[telegram-auth] failed to start provider process");
      return;
    }
    const flow: ActiveFlow = {
      ownerId, key, provider, chatId, pty, output: "", discoveryTail: "", timer: undefined,
      urlSent: false, codeSent: false, invalidated: false,
    };
    this.active.set(key, flow);
    this.attach(flow);
    await this.safeSend(chatId, providerLabel(provider) + " authentication started. Follow the instructions below. If the CLI asks you to paste a code, send it with /auth_input <code> (4-32 chars, A-Z, 0-9, -).");
  }

  stop(): void {
    for (const flow of this.active.values()) this.clear(flow, true);
    this.invalidatePending();
  }

  activeStatus(ownerId: number): string {
    const providers = [...this.active.values()].filter((flow) => flow.ownerId === ownerId).map((flow) => flow.provider).sort();
    return providers.length === 0 ? "No authentication flow is active." : "Active authentication flows: " + providers.map(providerLabel).join(", ") + ".";
  }

  async cancel(ownerId: number, chatId: AuthChatId): Promise<void> {
    const active = [...this.active.values()].filter((flow) => flow.ownerId === ownerId);
    const pending = [...this.pending.values()].filter((flow) => flow.ownerId === ownerId);
    if (active.length === 0 && pending.length === 0) return void (await this.safeSend(chatId, "No authentication flow is active."));
    for (const flow of active) this.clear(flow, true);
    this.invalidatePending(undefined, ownerId);
    await this.safeSend(chatId, "Authentication cancelled.");
  }

  async writeCode(ownerId: number, code: string, chatId: AuthChatId): Promise<void> {
    const flows = [...this.active.values()].filter((flow) => flow.ownerId === ownerId);
    if (flows.length === 0) return void (await this.safeSend(chatId, "No authentication flow is active."));
    if (flows.length > 1) return void (await this.safeSend(chatId, "Authentication input is ambiguous while multiple providers are active."));
    try {
      flows[0].pty.write(code + "\r");
    } catch {
      this.logger.warn?.("[telegram-auth] failed to write authentication input");
      await this.safeSend(chatId, "Authentication input failed.");
    }
  }

  hasFlow(ownerId: number, provider: AuthProvider): boolean {
    const key = flowKey(ownerId, provider);
    return this.active.has(key) || this.pending.has(key);
  }

  private attach(flow: ActiveFlow): void {
    const data = flow.pty.onData((chunk) => {
      if (this.active.get(flow.key) !== flow || flow.invalidated) return;
      updateDiscovery(flow, chunk);
      flow.output = appendOutput(flow.output, chunk);
      const lines = discoveryMessageLines(flow);
      if (lines.length > 1) void this.safeSend(flow.chatId, lines.join("\n"));
    });
    const exit = flow.pty.onExit((event) => void this.finish(flow, event.exitCode));
    flow.dataSubscription = data && typeof data === "object" ? data : undefined;
    flow.exitSubscription = exit && typeof exit === "object" ? exit : undefined;
    flow.timer = this.clock.setTimeout(() => this.timeout(flow), this.ttlSeconds * 1000);
  }

  private async finish(flow: ActiveFlow, exitCode: number): Promise<void> {
    if (this.active.get(flow.key) !== flow || flow.invalidated) return;
    const lines = discoveryMessageLines(flow);
    if (lines.length > 1) await this.safeSend(flow.chatId, lines.join("\n"));
    if (exitCode !== 0) {
      this.clear(flow, false);
      await this.safeSend(flow.chatId, providerLabel(flow.provider) + " authentication failed.");
      return;
    }
    this.detach(flow, false);
    this.pending.set(flow.key, flow);
    const { generation, promise } = this.verifier.begin(flow.provider);
    let verification: VerificationResult;
    try {
      verification = await promise;
    } catch {
      verification = { verified: false, timedOut: false, unavailable: true };
    } finally {
      if (this.pending.get(flow.key) === flow) this.pending.delete(flow.key);
    }
    if (flow.invalidated) return;
    this.verifier.cacheResult(flow.provider, verification, generation);
    await this.safeSend(flow.chatId, await this.result(flow, verification));
  }

  private async result(flow: ActiveFlow, verification: VerificationResult): Promise<string> {
    const provider = providerLabel(flow.provider);
    if (!verification.verified) {
      if (verification.timedOut) return `${provider} authentication verification timed out. Try again with /auth_${flow.provider}.`;
      if (verification.unavailable) return `${provider} authentication could not be verified. Check the provider CLI and try again with /auth_${flow.provider}.`;
      return provider + " authentication failed.";
    }
    let result = provider + " authentication succeeded: authenticated.";
    if (flow.provider === "claude") {
      const codex = await this.verifier.get("codex");
      if (!codex.verified && !codex.timedOut && !codex.unavailable && !this.hasFlow(flow.ownerId, "codex")) result += "\nNext: authenticate Codex with /auth_codex.";
    }
    return result;
  }

  private timeout(flow: ActiveFlow): void {
    if (this.active.get(flow.key) !== flow || flow.invalidated) return;
    this.clear(flow, true);
    void this.safeSend(flow.chatId, `Authentication timed out. Try again with /auth_${flow.provider}.`);
  }

  private invalidatePending(key?: string, ownerId?: number): void {
    for (const [pendingKey, flow] of this.pending) {
      if ((key === undefined || pendingKey === key) && (ownerId === undefined || flow.ownerId === ownerId)) {
        flow.invalidated = true;
        this.pending.delete(pendingKey);
      }
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
    flow.output = "";
    flow.discoveryTail = "";
  }

  private clear(flow: ActiveFlow, kill: boolean): void {
    if (this.active.get(flow.key) !== flow) return;
    this.detach(flow, true);
    if (kill) {
      try { flow.pty.kill(); } catch { this.logger.warn?.("[telegram-auth] failed to stop provider process"); }
    }
  }

  private async safeSend(chatId: AuthChatId, text: string): Promise<void> {
    try { await this.send(chatId, text); } catch { this.logger.warn?.("[telegram-auth] unable to send auth update"); }
  }
}
