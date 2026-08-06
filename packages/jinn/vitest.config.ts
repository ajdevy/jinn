import { defineConfig } from 'vitest/config'

// GitHub Actions (and most CI providers) set CI=true. The hosted runners are
// far smaller than a dev machine (few slow vCPUs, limited memory), and a large
// slice of this suite spins up REAL gateway servers, worker threads, and PTY
// proxies that bind real (ephemeral) ports. Under high fork parallelism those
// heavy integration tests pile onto the same starved cores, and operations that
// finish in milliseconds locally blow past the default 5s test / 10s hook
// timeouts on CI — producing cascading "step-timeout" / "socket lost" failures.
//
// So we scale vitest down ONLY in CI: fewer concurrent forks (less peak CPU/mem
// contention) and generous timeouts (slow-but-correct boots don't get killed).
// Local runs keep full parallelism and the snappy default timeouts.
const isCI = !!process.env.CI

// Windows needs the same headroom, for a different reason: it has no fork(), so
// every pool worker is a full process spawn that re-resolves the module graph
// from scratch, over NTFS, with realtime AV scanning each file. Suites whose
// beforeAll does `await import("../api.js")` — a 350KB module pulling in most of
// the gateway — routinely pass 10s under full local parallelism.
//
// This matters more than a slow test: vitest reports a timed-out hook by marking
// the file's tests SKIPPED, not failed. Around twenty suites (~180 tests,
// including the work-item and privileged-read guards) were dropping out of local
// Windows runs while the run still reported green.
const isWindows = process.platform === 'win32'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: './vitest.global-setup.ts',
    setupFiles: ['./vitest.setup.ts'],
    // Forks (the vitest v4 default) give each test file a clean process, which
    // matters for the gateway/PTY tests that mutate process-global state.
    pool: 'forks',
    // Cap concurrency on CI so heavy integration tests don't contend for the
    // runner's handful of cores and its limited memory. In vitest v4 the pool
    // concurrency is set via top-level maxWorkers/minWorkers (the old
    // poolOptions.forks.maxForks was removed). Locally we omit these so vitest
    // uses every available core.
    ...(isCI ? { minWorkers: 1, maxWorkers: 2 } : {}),
    // Give slow, resource-starved CI runners enough headroom to boot real
    // servers/workers/PTYs without tripping spurious timeouts.
    testTimeout: isCI || isWindows ? 30000 : 5000,
    hookTimeout: isCI || isWindows ? 30000 : 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      // A floor against regression, not an aspiration. Each value is the
      // coverage measured when this gate was wired up (74.7 statements /
      // 70.0 branches / 77.7 functions / 77.5 lines), rounded down and cut by
      // three points. That margin absorbs v8's run-to-run variance and the
      // CI-only maxWorkers: 2 path above — a gate that flakes red is a gate
      // everyone learns to ignore. Raise these when coverage genuinely rises.
      thresholds: {
        statements: 71,
        branches: 67,
        functions: 74,
        lines: 74,
      },
    },
  },
})
