import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const installedChrome = process.platform === 'win32'
  ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')
  : undefined
const chromiumPath = process.env.CHROMIUM_PATH
  ?? (installedChrome && existsSync(installedChrome) ? installedChrome : undefined)

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/e2e',
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: {
    command:
      process.platform === 'win32'
        ? 'set VITE_MOCK_IPC=true&& npm run dev:web -- --host 127.0.0.1'
        : 'VITE_MOCK_IPC=true npm run dev:web -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
