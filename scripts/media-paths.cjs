// Development/test helpers. Packaged apps resolve these resources through Electron.
const { existsSync } = require('node:fs')
const path = require('node:path')

function getMediaPath(name) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The media runtime supports Windows x64. Use Windows x64 Node.js.')
  }
  const executable = path.resolve(__dirname, '..', 'resources', 'media', 'win32-x64', `${name}.exe`)
  if (!existsSync(executable)) {
    throw new Error(`${name} is missing at ${executable}. Run npm run setup:media first.`)
  }
  return executable
}

exports.getFfmpegPath = () => getMediaPath('ffmpeg')
exports.getFfprobePath = () => getMediaPath('ffprobe')
