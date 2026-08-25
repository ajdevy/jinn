import { vi } from "vitest";
import {
  AuthFlowManager,
  type AuthClock,
  type AuthMessage,
  type AuthProvider,
  type AuthSpawnOptions,
} from "../auth-flow.js";

export function makePty(): any {
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const write = vi.fn<(data: string) => void>();
  const kill = vi.fn<(signal?: string) => void>();
  return {
    write,
    kill,
    onData: (handler: (data: string) => void) => { dataHandler = handler; return { dispose: vi.fn() }; },
    onExit: (handler: (event: { exitCode: number; signal?: number }) => void) => { exitHandler = handler; return { dispose: vi.fn() }; },
    emitData: (data: string) => dataHandler?.(data),
    emitExit: (event: { exitCode: number; signal?: number }) => exitHandler?.(event),
  };
}

export function makeHarness(options: {
  withVerifier?: boolean;
  ownerUserIds?: readonly number[];
  verifyTimeoutSeconds?: number;
  deleteSensitiveInputFromNonOwners?: boolean;
} = {}): any {
  const pty = makePty();
  const ptys = [pty];
  let spawnCount = 0;
  let nowMs = 0;
  let timeoutHandler: (() => void) | undefined;
  const clearTimeout = vi.fn();
  const clock: AuthClock = {
    now: () => nowMs,
    setTimeout: vi.fn((handler: () => void) => { timeoutHandler = handler; return 1; }),
    clearTimeout,
  };
  const send = vi.fn();
  const deleteMessage = vi.fn().mockResolvedValue(undefined);
  const spawnPty = vi.fn((_file: string, _args: string[], _options: AuthSpawnOptions) => {
    if (spawnCount === 0) { spawnCount += 1; return pty; }
    const nextPty = makePty();
    ptys.push(nextPty);
    spawnCount += 1;
    return nextPty;
  });
  const verifyAuth = vi.fn<(provider: AuthProvider) => Promise<boolean>>().mockResolvedValue(true);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new AuthFlowManager({
    ownerUserIds: options.ownerUserIds ?? [5658965359],
    clock,
    send,
    deleteMessage,
    spawnPty,
    ...(options.withVerifier === false ? {} : { verifyAuth }),
    deleteSensitiveInputFromNonOwners: options.deleteSensitiveInputFromNonOwners ?? true,
    verifyTimeoutSeconds: options.verifyTimeoutSeconds,
    logger,
  });
  return {
    manager, pty, ptys, clock, send, deleteMessage, spawnPty, verifyAuth, logger,
    fireTimeout: () => timeoutHandler?.(),
    advanceTime: (delayMs: number) => { nowMs += delayMs; },
  };
}

export function message(text: string, overrides: Partial<AuthMessage> = {}): AuthMessage {
  return { userId: 5658965359, chatType: "private", chatId: 123, messageId: 7, text, ...overrides };
}

export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
