import type {
  AuthClock,
  AuthLogger,
  AuthProvider,
  VerificationResult,
} from "./auth-flow-types.js";

const CACHE_MS = 5_000;

type CacheEntry = {
  result: VerificationResult;
  expiresAt: number;
  generation: number;
};

export class ProviderStatusVerifier {
  private readonly clock: AuthClock;
  private readonly verifyAuth?: (provider: AuthProvider) => Promise<boolean>;
  private readonly timeoutSeconds: number;
  private readonly logger: AuthLogger;
  private readonly cache = new Map<AuthProvider, CacheEntry>();
  private readonly inFlight = new Map<AuthProvider, Promise<VerificationResult>>();
  private readonly generations = new Map<AuthProvider, number>();

  constructor(options: {
    clock: AuthClock;
    verifyAuth?: (provider: AuthProvider) => Promise<boolean>;
    timeoutSeconds: number;
    logger: AuthLogger;
  }) {
    this.clock = options.clock;
    this.verifyAuth = options.verifyAuth;
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = options.logger;
  }

  hasFresh(provider: AuthProvider): boolean {
    const entry = this.cache.get(provider);
    return Boolean(entry && entry.expiresAt > this.now());
  }

  get(provider: AuthProvider): Promise<VerificationResult> {
    const entry = this.cache.get(provider);
    if (entry && entry.expiresAt > this.now()) return Promise.resolve(entry.result);
    const pending = this.inFlight.get(provider);
    if (pending) return pending;
    return this.begin(provider).promise;
  }

  begin(provider: AuthProvider): { generation: number; promise: Promise<VerificationResult> } {
    const generation = (this.generations.get(provider) ?? 0) + 1;
    this.generations.set(provider, generation);
    const promise = this.verifyWithTimeout(provider);
    this.inFlight.set(provider, promise);
    void promise
      .then((result) => this.cacheResult(provider, result, generation), () => undefined)
      .finally(() => {
        if (this.inFlight.get(provider) === promise) this.inFlight.delete(provider);
      });
    return { generation, promise };
  }

  cacheResult(provider: AuthProvider, result: VerificationResult, generation: number): void {
    const current = this.cache.get(provider);
    if (current && current.generation > generation) return;
    this.cache.set(provider, {
      result,
      expiresAt: this.now() + CACHE_MS,
      generation,
    });
  }

  private now(): number {
    return this.clock.now?.() ?? Date.now();
  }

  private async verifyWithTimeout(provider: AuthProvider): Promise<VerificationResult> {
    if (!this.verifyAuth) return { verified: false, timedOut: false, unavailable: false };
    let timeoutHandle: unknown;
    let timerCreated = false;
    try {
      const verification = Promise.resolve()
        .then(() => this.verifyAuth!(provider))
        .then(
          (verified) => ({ verified, timedOut: false, unavailable: false }),
          (error: unknown) => {
            this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
            const timedOut = typeof error === "object" && error !== null && (error as { timedOut?: unknown }).timedOut === true;
            return { verified: false, timedOut, unavailable: !timedOut };
          },
        );
      const timeout = new Promise<VerificationResult>((resolve) => {
        timeoutHandle = this.clock.setTimeout(
          () => resolve({ verified: false, timedOut: true, unavailable: false }),
          this.timeoutSeconds * 1000,
        );
        timerCreated = true;
      });
      return await Promise.race([verification, timeout]);
    } catch {
      this.logger.warn?.("[telegram-auth] post-exit authentication verification failed");
      return { verified: false, timedOut: false, unavailable: true };
    } finally {
      if (timerCreated) this.clock.clearTimeout(timeoutHandle);
    }
  }
}
