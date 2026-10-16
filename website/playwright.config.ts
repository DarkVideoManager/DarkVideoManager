import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const chrome = join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Google/Chrome/Application/chrome.exe',
)
export default defineConfig({
  testDir: './e2e',
  outputDir: '../test-results/website-e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4180',
    ...(process.env.CHROMIUM_PATH || existsSync(chrome)
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH || chrome } }
      : {}),
  },
  webServer: {
    command: 'node server.mjs',
    env: { DVM_WEBSITE_PORT: '4180' },
    url: 'http://127.0.0.1:4180',
    reuseExistingServer: false,
  },
})
