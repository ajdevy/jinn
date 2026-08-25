import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { TelegramConnectorConfig } from "../../../shared/types.js";
import { JINN_HOME } from "../../../shared/paths.js";

export { fs, path, JINN_HOME };

export function authMenuStateDir(): string {
  return path.join(JINN_HOME, "state", "telegram-auth-menu-owners", process.env.JINN_TELEGRAM_AUTH_TEST_SCOPE ?? "default");
}

export const realExistsSync = fs.existsSync.bind(fs);
export const mockSendMessage: any = vi.fn().mockResolvedValue({ message_id: 1 });
export const mockDeleteMessage: any = vi.fn().mockResolvedValue(true);
export const mockDeleteMyCommands: any = vi.fn().mockResolvedValue(true);
export const mockGetMe: any = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
export const mockGetMyCommands: any = vi.fn().mockResolvedValue([]);
export const mockSetMyCommands: any = vi.fn().mockResolvedValue(true);
export const mockStartPolling: any = vi.fn();
export const mockStopPolling: any = vi.fn().mockResolvedValue(undefined);
export const mockOn: any = vi.fn();
export const mockRemoveListener: any = vi.fn();
export const mockPtyWrite: any = vi.fn();
export const mockPtyKill: any = vi.fn();
export const mockPtyOnData: any = vi.fn();
export const mockPtyOnExit: any = vi.fn();
export const mockExecFile: any = vi.fn();
export const mockPtySpawn: any = vi.fn(() => ({ write: mockPtyWrite, kill: mockPtyKill, onData: mockPtyOnData, onExit: mockPtyOnExit }));

export async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.deleteMessage = mockDeleteMessage;
    this.deleteMyCommands = mockDeleteMyCommands;
    this.getMe = mockGetMe;
    this.getMyCommands = mockGetMyCommands;
    this.setMyCommands = mockSetMyCommands;
    this.startPolling = mockStartPolling;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
    this.removeListener = mockRemoveListener;
  });
  return { default: MockBot };
});
vi.mock("node-pty", () => ({ spawn: mockPtySpawn }));
vi.mock("node:child_process", () => ({ execFile: mockExecFile, spawn: vi.fn() }));
vi.mock("../../../shared/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

export const { TelegramConnector } = await import("../index.js");

export function mockClaudeAuthStatus(loggedIn = false): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error | null, stdout?: string, stderr?: string) => void;
    queueMicrotask(() => callback(null, JSON.stringify({ loggedIn }), ""));
    return { kill: vi.fn() };
  });
}

export function resetAuthFixtures(scope = "default"): void {
  vi.clearAllMocks();
  process.env.JINN_TELEGRAM_AUTH_TEST_SCOPE = scope;
  mockExecFile.mockReset();
  mockClaudeAuthStatus();
  vi.spyOn(fs, "existsSync").mockImplementation((target) => String(target) === "/home/node/.codex/auth.json" ? false : realExistsSync(target));
  fs.rmSync(authMenuStateDir(), { recursive: true, force: true });
}

export function makeConnector(config: Partial<TelegramConnectorConfig> = {}): InstanceType<typeof TelegramConnector> {
  return new TelegramConnector({ botToken: "123456:ABC-DEF", ...config });
}

export function resetMenuMocks(): void {
  vi.useRealTimers();
  mockSetMyCommands.mockReset().mockResolvedValue(true);
  mockDeleteMyCommands.mockReset().mockResolvedValue(true);
}
