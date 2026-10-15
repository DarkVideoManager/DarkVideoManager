import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY'])
const retryDelays = [20, 60, 120]
const sleeper = new Int32Array(new SharedArrayBuffer(4))

export class SubtitleQueueStorageError extends Error {
  constructor(file: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException)?.code || 'UNKNOWN'
    super(
      `자막 대기열을 저장하지 못했습니다 (${code}). 기존 저장 파일은 보존했습니다. ` +
        `저장 위치의 쓰기 권한과 다른 프로그램의 파일 사용 상태를 확인한 뒤 대기열에서 '저장 다시 시도'를 누르세요. 파일: ${file}`,
      { cause },
    )
    this.name = 'SubtitleQueueStorageError'
  }
}

/** Replace only after a complete, flushed snapshot; never delete the durable queue. */
export function writeSubtitleQueueSnapshot(file: string, value: unknown): void {
  const temporary = file + '.tmp.' + randomUUID()
  let fd: number | undefined
  let saved = false
  try {
    mkdirSync(dirname(file), { recursive: true })
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, JSON.stringify(value), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file)
        saved = true
        break
      } catch (error) {
        if (
          !transientCodes.has((error as NodeJS.ErrnoException).code ?? '') ||
          attempt >= retryDelays.length
        )
          throw error
        // Keep the synchronous queue admission contract; total waiting is bounded to 200 ms.
        Atomics.wait(sleeper, 0, 0, retryDelays[attempt])
      }
    }
  } catch (error) {
    throw new SubtitleQueueStorageError(file, error)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* Preserve the original storage error. */
      }
    }
    if (!saved) {
      try {
        unlinkSync(temporary)
      } catch {
        /* A locked temporary file can be inspected later. */
      }
    }
  }
}
