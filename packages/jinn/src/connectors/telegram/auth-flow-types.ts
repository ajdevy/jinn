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
  onExit(handler: (event: { exitCode: number; signal?: number }) => void):
    { dispose?: () => void } | void;
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
  deleteMessage: (chatId: AuthChatId, messageId: number | string) => void | Promise<void>;
  spawnPty: SpawnPty;
  providerEnv?: Record<string, string>;
  verifyAuth?: (provider: AuthProvider) => Promise<boolean>;
  deleteSensitiveInputFromNonOwners?: boolean;
  verifyTimeoutSeconds?: number;
  logger: AuthLogger;
  flowTtlSeconds?: number;
}

export type VerificationResult = {
  verified: boolean;
  timedOut: boolean;
  unavailable: boolean;
};

export type FlowKey = string;

export interface ActiveFlow {
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
  invalidated: boolean;
  dataSubscription?: { dispose?: () => void };
  exitSubscription?: { dispose?: () => void };
}
