import {
  type AuthChatId,
  type AuthFlowManagerOptions,
  type AuthInputSource,
  type AuthProvider,
} from "./auth-flow-support.js";
import { AuthFlowLifecycle } from "./auth-flow-lifecycle.js";

export class AuthFlowRuntime {
  private readonly lifecycle: AuthFlowLifecycle;
  private readonly sendMessage: AuthFlowManagerOptions["send"];

  constructor(options: AuthFlowManagerOptions) {
    this.sendMessage = options.send;
    this.lifecycle = new AuthFlowLifecycle(options);
  }

  start(ownerId: number, provider: AuthProvider, chatId: AuthChatId): Promise<void> {
    return this.lifecycle.start(ownerId, provider, chatId);
  }

  async status(ownerId: number, chatId: AuthChatId): Promise<void> {
    const text = await this.lifecycle.status(ownerId);
    await this.send(chatId, text);
  }

  hasActiveFlow(ownerId: number): boolean {
    return this.lifecycle.hasActiveFlow(ownerId);
  }

  async cancel(ownerId: number, chatId: AuthChatId): Promise<void> {
    const result = this.lifecycle.cancel(ownerId);
    await this.send(
      chatId,
      result === "cancelled"
        ? "Authentication cancelled."
        : "No authentication flow is active.",
    );
  }

  async input(ownerId: number, code: string, source: AuthInputSource, chatId: AuthChatId): Promise<void> {
    const result = this.lifecycle.input(ownerId, code, source);
    const message = {
      none: "No authentication flow is active.",
      ambiguous: "Authentication input is ambiguous while multiple providers are active.",
      wrongProvider: "A Claude callback can only be used with /auth_claude.",
      failed: "Authentication input failed.",
      written: undefined,
    }[result];
    if (message) await this.send(chatId, message);
  }

  stop(): void {
    this.lifecycle.stop();
  }

  private async send(chatId: AuthChatId, text: string): Promise<void> {
    try {
      await this.sendMessage(chatId, text);
    } catch {
      // The connector owns the actual sender and logs send failures.
    }
  }
}
