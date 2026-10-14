import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  SubtitleEngineInfo,
  SubtitleGenerationJob,
  SubtitleGenerationOptions,
} from '@shared/types'
import { getFfmpegPath } from '../ffmpeg/ffmpegPath'
import { createAbortError } from '../ffmpeg/queue'
import { throwIfWorkCancelled } from './LibraryWorkService'
import { translateWithCloud } from './CloudTranslationService'
import { subtitleWslArgs as wslArgs } from './SubtitleWslEnvironment'

export interface TranscriptionResult {
  language: string
  cueCount: number
  translated: boolean
  translationError?: string
}
type Progress = Pick<SubtitleGenerationJob, 'phase' | 'percent' | 'message'>
export type SubtitleProgressHandler = (progress: Progress) => void

export function toWslPath(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'wsl.exe',
      [...wslArgs(), 'wslpath', '-a', '-u', filePath],
      { windowsHide: true, timeout: 20_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error)
          reject(
            new Error('WSL 경로에 접근할 수 없습니다. WSL 배포판과 파일 위치를 확인하세요.', {
              cause: error,
            }),
          )
        else {
          const result = stdout.trim()
          if (!result.startsWith('/')) reject(new Error('WSL 경로 변환에 실패했습니다.'))
          else resolve(result)
        }
      },
    )
  })
}

function workerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'subtitles', 'generate.py')
    : join(app.getAppPath(), 'resources', 'subtitles', 'generate.py')
}

function nativePythonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'subtitles', 'native', 'python', 'python.exe')
    : join(app.getAppPath(), 'resources', 'subtitles', 'native', 'python', 'python.exe')
}

// An existing transcript must continue with the engine that created its checkpoint.
// New jobs use Vulkan; failed GPU initialization must never silently select the CPU.
export function subtitleCheckpointEngine(outputDir: string): {
  backend: 'cpu' | 'vulkan'
  transcriptionComplete: boolean
} {
  const checkpoint = join(outputDir, 'checkpoint.json')
  if (!existsSync(checkpoint)) return { backend: 'vulkan', transcriptionComplete: false }
  try {
    const state = JSON.parse(readFileSync(checkpoint, 'utf8'))
    if (
      state?.version !== 1 ||
      !state.identity ||
      typeof state.transcription_complete !== 'boolean' ||
      (state.identity.backend !== undefined && state.identity.backend !== 'vulkan')
    )
      throw new Error('지원되지 않는 자막 재개 정보입니다.')
    return {
      backend: state.identity.backend === 'vulkan' ? 'vulkan' : 'cpu',
      transcriptionComplete: state.transcription_complete,
    }
  } catch (error) {
    throw new Error('저장된 자막 진행 내용을 읽을 수 없습니다. 작업을 확인하세요.', {
      cause: error,
    })
  }
}

// The only executable path is our managed venv; filenames are always separate argv entries.
const BOOTSTRAP =
  "import os,sys; p=os.path.expanduser('~/.local/share/dark-video-manager/venv/bin/python'); os.execv(p,[p,'-u']+sys.argv[1:])"

interface CommandOptions {
  signal?: AbortSignal
  cooperative?: boolean
  timeoutMs?: number
  onLine?: (line: string, reply: (value: unknown) => void, signal: AbortSignal) => void
}

export function runSubtitleCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<void> {
  throwIfWorkCancelled(options.signal)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let failure: Error | undefined
    let stderr = ''
    let finished = false
    const lifetime = new AbortController()
    const stop = () => {
      lifetime.abort()
      // Closing the pipe is observed by the Python watchdog even while inference runs.
      if (options.cooperative) child.stdin.end()
      else child.kill()
    }
    const abort = () => {
      failure = createAbortError()
      stop()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => undefined) // An exiting worker can close the pipe first.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      stderr = (stderr + text).slice(-4000)
    })
    const lines = createInterface({ input: child.stdout })
    const reply = (value: unknown) => {
      if (finished || failure || lifetime.signal.aborted || !child.stdin.writable) return
      try {
        child.stdin.write(JSON.stringify(value) + '\n', 'utf8')
      } catch {
        failure = new Error('자막 엔진과의 통신이 중단되었습니다.')
        stop()
      }
    }
    lines.on('line', (line) => {
      if (failure) return
      try {
        options.onLine?.(line, reply, lifetime.signal)
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        stop()
      }
    })
    const timeout = setTimeout(
      () => {
        failure = new Error('자막 처리 제한 시간을 초과했습니다. 환경을 확인하고 다시 시도하세요.')
        stop()
      },
      options.timeoutMs ?? 6 * 60 * 60 * 1000,
    )
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      lifetime.abort()
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      lines.close()
      if (error) reject(error)
      else resolve()
    }
    child.once('error', (error) => finish(failure ?? error))
    child.once('close', (code) =>
      finish(
        failure ??
          (code === 0
            ? undefined
            : new Error(stderr.trim() || `자막 처리 프로세스가 종료되었습니다 (${code}).`)),
      ),
    )
    if (options.signal?.aborted) abort()
  })
}

export async function getSubtitleEngineInfo(): Promise<SubtitleEngineInfo> {
  if (process.platform !== 'win32')
    return { available: false, message: 'GPU 자막 생성은 Windows의 Vulkan 환경을 사용합니다.' }
  try {
    let gpuReady = false
    await runSubtitleCommand(
      nativePythonPath(),
      ['-X', 'utf8', '-u', workerPath(), '--backend', 'vulkan', '--check'],
      {
        timeoutMs: 30_000,
        onLine: (line) => {
          if (JSON.parse(line).available === true) gpuReady = true
        },
      },
    )
    if (!gpuReady) throw new Error('GPU 음성 인식 엔진을 확인하지 못했습니다.')
    let available = false
    const script = await toWslPath(workerPath())
    await runSubtitleCommand(
      'wsl.exe',
      [...wslArgs(), 'python3', '-c', BOOTSTRAP, script, '--check'],
      {
        timeoutMs: 30_000,
        onLine: (line) => {
          const data = JSON.parse(line)
          if (data.available === true) {
            available = true
          }
        },
      },
    )
    if (!available) throw new Error('자막 엔진 응답을 확인하지 못했습니다.')
    getFfmpegPath()
    return {
      available,
      message: 'GPU 음성 인식 · Vulkan 엔진 준비 완료. 새 작업은 GPU로 처리합니다.',
    }
  } catch (error) {
    return {
      available: false,
      message: `자막 생성 탭에서 자막 환경 자동 설치를 눌러 주세요. ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function extractSubtitleAudio(
  videoPath: string,
  audioPath: string,
  duration: number | undefined,
  signal: AbortSignal,
  onProgress: SubtitleProgressHandler,
): Promise<void> {
  await runSubtitleCommand(
    getFfmpegPath(),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-i',
      videoPath,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      'highpass=f=80,lowpass=f=8000',
      '-c:a',
      'pcm_s16le',
      '-progress',
      'pipe:1',
      audioPath,
    ],
    {
      signal,
      onLine: (line) => {
        const match = /^out_time_us=(\d+)$/.exec(line)
        if (match && duration && duration > 0)
          onProgress({
            phase: 'preparing',
            percent: Math.min(99, (Number(match[1]) / 1e6 / duration) * 100),
            message: '음성을 추출하고 있습니다.',
          })
      },
    },
  )
}

export async function transcribeSubtitleAudio(
  audioPath: string,
  outputDir: string,
  options: SubtitleGenerationOptions,
  signal: AbortSignal,
  onProgress: SubtitleProgressHandler,
  resume = false,
): Promise<TranscriptionResult> {
  const checkpoint = subtitleCheckpointEngine(outputDir)
  const [script, audio, output] = await Promise.all([
    toWslPath(workerPath()),
    toWslPath(audioPath),
    toWslPath(outputDir),
  ])
  throwIfWorkCancelled(signal)
  let result: TranscriptionResult | undefined
  let cloudPending = false
  let lastCloudRequestId = 0
  const commonArgs = [
    '--model',
    options.model,
    '--language',
    options.language,
    ...(options.translateToKorean ? ['--translate-ko'] : []),
    ...(resume ? ['--resume'] : []),
  ]
  const commandOptions: CommandOptions = {
    signal,
    cooperative: true,
    onLine: (line, reply, workerSignal) => {
      const data = JSON.parse(line)
      if (data.type === 'cloud_translation_request') {
        if (
          !options.translateToKorean ||
          cloudPending ||
          !Number.isSafeInteger(data.id) ||
          data.id <= lastCloudRequestId ||
          typeof data.text !== 'string' ||
          typeof data.language !== 'string' ||
          !/^[a-z]{2,3}$/.test(data.language)
        )
          throw new Error('자막 엔진의 번역 요청이 올바르지 않습니다.')
        lastCloudRequestId = data.id
        cloudPending = true
        void translateWithCloud(data.text, data.language, workerSignal)
          .then(
            (response) => reply({ type: 'cloud_translation_response', id: data.id, ...response }),
            () =>
              reply({
                type: 'cloud_translation_response',
                id: data.id,
                ok: false,
                reason: 'Google Cloud 번역을 사용할 수 없어 Ollama로 전환합니다.',
              }),
          )
          .finally(() => {
            cloudPending = false
          })
      } else if (data.phase === 'completed') {
        if (
          !Number.isInteger(data.cueCount) ||
          data.cueCount < 1 ||
          !/^[a-z]{2,3}$/.test(data.language) ||
          data.original !== 'original.srt' ||
          (data.translated !== undefined && data.translated !== 'ko.srt')
        )
          throw new Error('자막 엔진의 결과가 올바르지 않습니다.')
        result = {
          language: data.language,
          cueCount: data.cueCount,
          translated: data.translated === 'ko.srt',
          ...(typeof data.translationError === 'string' && data.translationError
            ? { translationError: data.translationError.slice(0, 1000) }
            : {}),
        }
      } else if (['loading', 'transcribing', 'translating'].includes(data.phase)) {
        onProgress({
          phase: data.phase,
          percent: Number.isFinite(data.percent) ? Math.max(0, Math.min(100, data.percent)) : 0,
          message:
            data.phase === 'transcribing' && checkpoint.backend === 'cpu'
              ? '기존 CPU 작업의 음성 인식을 이어서 처리하고 있습니다.'
              : typeof data.message === 'string'
                ? data.message
                : data.phase === 'transcribing' && checkpoint.backend === 'vulkan'
                  ? 'GPU · Vulkan으로 음성을 인식하고 있습니다.'
                  : '자막을 처리하고 있습니다.',
        })
      }
    },
  }
  if (checkpoint.backend === 'vulkan' && !checkpoint.transcriptionComplete) {
    await runSubtitleCommand(
      nativePythonPath(),
      [
        '-X',
        'utf8',
        '-u',
        workerPath(),
        '--backend',
        'vulkan',
        '--transcribe-only',
        '--checkpoint-audio',
        audio,
        '--audio',
        audioPath,
        '--output',
        outputDir,
        ...commonArgs,
      ],
      commandOptions,
    )
    throwIfWorkCancelled(signal)
    if (!result) throw new Error('GPU 음성 인식 엔진이 결과를 반환하지 않았습니다.')
  }
  // WSL keeps the existing translation providers and their bounded retries.
  // The native worker writes a compatible, finished transcript before handoff.
  if (
    checkpoint.backend === 'cpu' ||
    options.translateToKorean ||
    checkpoint.transcriptionComplete
  ) {
    result = undefined
    await runSubtitleCommand(
      'wsl.exe',
      [
        ...wslArgs(),
        'python3',
        '-c',
        BOOTSTRAP,
        script,
        '--audio',
        audio,
        '--output',
        output,
        ...commonArgs,
        ...(options.translateToKorean ? ['--cloud-translation-bridge'] : []),
        ...(checkpoint.backend === 'vulkan' ? ['--backend', 'vulkan', '--resume'] : []),
      ],
      commandOptions,
    )
  }
  throwIfWorkCancelled(signal)
  if (!result) throw new Error('자막 엔진이 결과를 반환하지 않았습니다.')
  if (options.translateToKorean && !result.translated && !result.translationError)
    throw new Error('한국어 번역 결과가 없습니다.')
  return result
}
