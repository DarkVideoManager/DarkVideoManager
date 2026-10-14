// Use the same Node ABI as the Electron app's native SQLite module.
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const result = spawnSync(require('electron'), [
  resolve(__dirname, '../node_modules/vitest/vitest.mjs'),
  'run',
  ...process.argv.slice(2),
], {
  cwd: resolve(__dirname, '..'),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
