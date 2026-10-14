import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

// Both tools come from the same reproducible media build, in development and releases.
function getMediaPath(name: 'ffmpeg' | 'ffprobe'): string {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('미디어 런타임은 Windows x64에서 지원됩니다.')
  }
  const resources = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  const executable = join(resources, 'media', 'win32-x64', `${name}.exe`)
  if (!existsSync(executable)) {
    throw new Error(
      `${name} 실행 파일을 찾을 수 없습니다. 개발 환경에서는 npm run setup:media를 실행하고, 배포 앱은 전체 폴더를 다시 설치해 주세요.`,
    )
  }
  return executable
}

export function getFfmpegPath(): string {
  return getMediaPath('ffmpeg')
}

export function getFfprobePath(): string {
  return getMediaPath('ffprobe')
}
