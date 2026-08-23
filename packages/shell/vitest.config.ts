import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The sources, not the build output. `build` compiles this package to
    // `dist/`, tests included, and without this the same suite is discovered
    // twice and reported as twice as many passing tests as were written.
    include: ["*.test.ts"],
  },
})
