// Installed VLC smoke test. No UI, user preferences, library, or original media are used.
// VLC options: https://videolan.videolan.me/vlc-3.0/libvlc-module_8c.html
// Windows dummy interface: https://github.com/videolan/vlc/blob/3.0.x/modules/control/dummy.c
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')

const executable = process.argv[2] || 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'
assert.ok(fs.existsSync(executable), 'Pass the installed VLC executable path')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dvm-native-smoke-'))
const media = path.join(temporary, 'sample.mp4')
const logPath = path.join(temporary, 'vlc.log')
for (const name of ['roaming', 'local']) fs.mkdirSync(path.join(temporary, name))
execFileSync(
  require('./media-paths.cjs').getFfmpegPath(),
  ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=2', '-pix_fmt', 'yuv420p', media],
  { windowsHide: true, stdio: 'ignore' },
)
const started = Date.now()
const result = spawnSync(
  executable,
  [
    '--ignore-config',
    '--no-one-instance',
    '--no-media-library',
    '--intf=dummy',
    '--dummy-quiet',
    '--vout=dummy',
    '--aout=dummy',
    '--play-and-exit',
    '--file-logging',
    '--log-verbose=2',
    '--verbose=2',
    '--logfile=' + logPath,
    '--',
    media,
  ],
  {
    windowsHide: true,
    cwd: temporary,
    timeout: 30_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      APPDATA: path.join(temporary, 'roaming'),
      LOCALAPPDATA: path.join(temporary, 'local'),
    },
  },
)
const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
const report = {
  executable,
  temporary,
  exitCode: result.status,
  elapsedMs: Date.now() - started,
  decodedVideo: /using video decoder module/.test(log),
  reachedEnd: /EOF reached|end of.*input|nothing to play|exiting/.test(log),
  error: result.error?.message ?? null,
  logPath,
}
fs.mkdirSync(path.resolve(__dirname, '../test-results'), { recursive: true })
fs.writeFileSync(
  path.resolve(__dirname, '../test-results/native-vlc.json'),
  JSON.stringify(report, null, 2),
)
console.log(JSON.stringify(report, null, 2))
assert.equal(result.error, undefined)
assert.equal(result.status, 0)
assert.ok(report.decodedVideo, 'VLC did not report a video decoder')
assert.ok(report.reachedEnd, 'VLC did not report completed playback')
