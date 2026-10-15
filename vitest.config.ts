import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    // Windows/WSL process fixtures share the host; serialize to avoid startup timeout races.
    maxWorkers: 1,
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
  },
})
