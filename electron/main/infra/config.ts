import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { Config } from '@shared/types'
import { getConfigPath } from './paths'

// passthrough keeps settings added by later versions instead of silently dropping them.
const NonemptyString = z.string().min(1)
const ConfigSchema = z
  .object({
    libraries: z
      .array(
        z
          .object({
            id: NonemptyString,
            name: NonemptyString,
            dbPath: NonemptyString,
            folderPath: NonemptyString,
            folderPaths: z.array(NonemptyString).optional(),
            createdAt: NonemptyString,
            lastOpenedAt: NonemptyString.optional(),
          })
          .passthrough(),
      )
      .refine(
        (libraries) => new Set(libraries.map((library) => library.id)).size === libraries.length,
        '라이브러리 ID가 중복되었습니다.',
      ),
    lastActiveLibraryId: NonemptyString.optional(),
    cacheLimitGb: z.number().finite().min(1).max(1000).optional(),
    githubStarPromptShown: z.boolean().optional(),
    nativePlayer: z
      .object({ name: z.enum(['mpv', 'ffplay', 'vlc']), path: NonemptyString })
      .nullable()
      .optional(),
  })
  .passthrough()

type Candidate =
  | { kind: 'valid'; raw: string; config: Config }
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
let recoveryNotice: string | undefined
const renameRetryDelays = [10, 25, 50, 100, 200]
const renameRetryWait = new Int32Array(new SharedArrayBuffer(4))

function replaceFile(temporaryPath: string, filePath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temporaryPath, filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error
      // Windows can briefly deny replacement while antivirus or another reader
      // holds the destination. Keep the old file intact throughout every retry.
      const delay = renameRetryDelays[attempt]
      if (delay === undefined) {
        throw new Error(
          '설정 파일을 저장할 수 없습니다 (' +
            code +
            '): ' +
            filePath +
            '. 파일과 폴더의 쓰기 권한·읽기 전용 속성을 확인하고, 이 파일을 사용 중인 다른 프로그램을 닫은 뒤 다시 시도해 주세요. 기존 설정 파일은 삭제하지 않았습니다.',
          { cause: error },
        )
      }
      Atomics.wait(renameRetryWait, 0, 0, delay)
    }
  }
}

function validateConfig(value: unknown): Config {
  const result = ConfigSchema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error('설정 구조가 올바르지 않습니다: ' + issue.path.join('.') + ' ' + issue.message)
  }
  return result.data as Config
}

function readCandidate(filePath: string): Candidate {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw new Error('설정 파일을 읽을 수 없습니다: ' + filePath, { cause: error })
  }
  try {
    return { kind: 'valid', raw, config: validateConfig(JSON.parse(raw.replace(/^\uFEFF/, ''))) }
  } catch (error) {
    return { kind: 'invalid', reason: (error as Error).message }
  }
}

/** The old target remains intact until a fully written, flushed replacement is ready. */
function writeAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = filePath + '.tmp.' + process.pid + '.' + randomUUID()
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    replaceFile(temporaryPath, filePath)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch (error) {
      // A successful rename already removed the temporary path. Cleanup failure
      // must not replace the original write error or invalidate a committed file.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        /* recoverable orphan */
      }
    }
  }
}

function preserveCorrupt(filePath: string): string {
  const preservedPath = filePath + '.corrupt.' + Date.now() + '.' + randomUUID()
  renameSync(filePath, preservedPath)
  return preservedPath
}

function hasPreviousInstallation(filePath: string): boolean {
  const directory = dirname(filePath)
  try {
    if (readdirSync(directory).some((name) => name.startsWith(basename(filePath) + '.')))
      return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    return readdirSync(join(directory, 'libs')).some((name) => /\.db(?:-|\.|$)/i.test(name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

function readCurrent(filePath: string): { config: Config; raw?: string } {
  const primary = readCandidate(filePath)
  if (primary.kind === 'valid') return primary
  const backupPath = filePath + '.bak'
  const backup = readCandidate(backupPath)
  if (backup.kind === 'valid') {
    const preservedPath = primary.kind === 'invalid' ? preserveCorrupt(filePath) : undefined
    writeAtomic(filePath, backup.raw)
    recoveryNotice = preservedPath
      ? '설정 파일이 손상되어 정상 백업으로 복원했습니다. 손상 원본: ' + preservedPath
      : '설정 파일이 없어 정상 백업으로 복원했습니다.'
    return backup
  }
  if (
    primary.kind === 'missing' &&
    backup.kind === 'missing' &&
    !hasPreviousInstallation(filePath)
  ) {
    return { config: { libraries: [] } }
  }
  const details = [
    primary.kind === 'invalid' ? '주파일: ' + primary.reason : '주파일 없음',
    backup.kind === 'invalid' ? '백업: ' + backup.reason : '정상 백업 없음',
  ].join('; ')
  throw new Error(
    '설정을 안전하게 복원할 수 없습니다. 기존 파일을 보존했으며 빈 설정으로 덮어쓰지 않습니다. ' +
      filePath +
      ' (' +
      details +
      ')',
  )
}

export function loadConfig(): Config {
  return readCurrent(getConfigPath()).config
}

export function saveConfig(config: Config): void {
  // Validate the serialized form too: custom toJSON/undefined must not bypass
  // validation and leave an unreadable configuration on disk.
  const validated = validateConfig(config)
  const content = JSON.stringify(validated, null, 2)
  validateConfig(JSON.parse(content))
  const filePath = getConfigPath()
  const current = readCurrent(filePath)
  // Library creation first ensures that the registry exists. Re-saving an
  // existing registry must not needlessly replace a backup that may be open.
  if (current.raw !== undefined && JSON.stringify(current.config, null, 2) === content) return
  if (current.raw !== undefined) {
    const backupPath = filePath + '.bak'
    const backup = readCandidate(backupPath)
    if (backup.kind === 'invalid') preserveCorrupt(backupPath)
    // An equivalent valid backup already protects the version being replaced.
    // In particular, the first library need not replace the empty backup again.
    if (
      backup.kind !== 'valid' ||
      JSON.stringify(backup.config) !== JSON.stringify(current.config)
    ) {
      writeAtomic(backupPath, current.raw)
    }
  }
  writeAtomic(filePath, content)
}

export function updateConfig(fn: (config: Config) => Config): Config {
  const updated = fn(loadConfig())
  saveConfig(updated)
  return updated
}

export function takeConfigRecoveryNotice(): string | undefined {
  const notice = recoveryNotice
  recoveryNotice = undefined
  return notice
}
