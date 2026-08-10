import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Kept in step with vite.config.ts: a suite that resolved the SDK by a
      // different route would prove nothing about what the app ships.
      '@jinn/plugin-sdk': path.resolve(__dirname, 'src/plugins/sdk/index.ts'),
    },
  },
})
