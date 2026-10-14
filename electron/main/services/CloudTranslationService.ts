import { app, safeStorage } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAbortError } from '../ffmpeg/queue'

export const CLOUD_TRANSLATION_FREE_CHARACTERS = 500_000
export const CLOUD_TRANSLATION_MONTH_TIME_ZONE = 'America/Los_Angeles'
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2'
const STORAGE_ERROR =
  'Google Cloud 사용량 기록을 안전하게 읽거나 저장할 수 없어 Ollama를 사용합니다.'

export interface CloudTranslationSettings {
  enabled: boolean
  hasApiKey: boolean
  monthlyLimit: number
  month: string
  usedCharacters: number
  externalCharacters: number
  remainingCharacters: number
  storageError?: string
}

export interface CloudTranslationSettingsPatch {
  enabled?: boolean
  apiKey?: string
  removeApiKey?: boolean
  monthlyLimit?: number
  externalCharacters?: number
}

export type CloudTranslationResult = { ok: true; text: string } | { ok: false; reason: string }

interface MonthUsage {
  usedCharacters: number
  externalCharacters: number
}

interface SavedSettings {
  version: 1
  enabled: boolean
  encryptedApiKey?: string
  monthlyLimit: number
  months: Record<string, MonthUsage>
}

interface Encryption {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(bytes: Buffer): string
}

interface Dependencies {
  storagePath: string
  encryption: Encryption
  fetch?: typeof fetch
  now?: () => Date
  timeoutMs?: number
}

function monthAt(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLOUD_TRANSLATION_MONTH_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  return `${parts.find((part) => part.type === 'year')!.value}-${parts.find((part) => part.type === 'month')!.value}`
}

function isCount(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function emptySettings(): SavedSettings {
  return { version: 1, enabled: false, monthlyLimit: CLOUD_TRANSLATION_FREE_CHARACTERS, months: {} }
}

function parseSavedSettings(text: string): SavedSettings {
  const value = JSON.parse(text) as SavedSettings
  if (
    !value ||
    Object.keys(value).some(
      (key) => !['version', 'enabled', 'encryptedApiKey', 'monthlyLimit', 'months'].includes(key),
    ) ||
    value.version !== 1 ||
    typeof value.enabled !== 'boolean' ||
    !isCount(value.monthlyLimit, CLOUD_TRANSLATION_FREE_CHARACTERS) ||
    !value.months ||
    typeof value.months !== 'object' ||
    Array.isArray(value.months) ||
    (value.encryptedApiKey !== undefined &&
      (typeof value.encryptedApiKey !== 'string' ||
        value.encryptedApiKey.length === 0 ||
        value.encryptedApiKey.length > 32_768 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value.encryptedApiKey,
        )))
  )
    throw new Error(STORAGE_ERROR)
  for (const [month, usage] of Object.entries(value.months)) {
    if (
      !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month) ||
      !usage ||
      Object.keys(usage).some((key) => !['usedCharacters', 'externalCharacters'].includes(key)) ||
      !isCount(usage.usedCharacters) ||
      !isCount(usage.externalCharacters)
    )
      throw new Error(STORAGE_ERROR)
  }
  return value
}

export class CloudTranslationService {
  private readonly request: typeof fetch
  private readonly now: () => Date
  private readonly timeoutMs: number
  private storageFailed = false
  private hasSeenFile = false

  constructor(private readonly dependencies: Dependencies) {
    this.request = dependencies.fetch ?? globalThis.fetch
    this.now = dependencies.now ?? (() => new Date())
    this.timeoutMs = dependencies.timeoutMs ?? 20_000
  }

  private read(): SavedSettings {
    if (this.storageFailed) throw new Error(STORAGE_ERROR)
    try {
      if (!existsSync(this.dependencies.storagePath)) {
        if (this.hasSeenFile) throw new Error(STORAGE_ERROR)
        return emptySettings()
      }
      this.hasSeenFile = true
      return parseSavedSettings(readFileSync(this.dependencies.storagePath, 'utf8'))
    } catch {
      this.storageFailed = true
      throw new Error(STORAGE_ERROR)
    }
  }

  private write(settings: SavedSettings): void {
    const file = this.dependencies.storagePath
    const temporary = `${file}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(settings)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, file)
      this.hasSeenFile = true
      // Windows does not support opening directories for fsync; the file itself is flushed above.
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(file), 'r')
        try {
          fsyncSync(directory)
        } finally {
          closeSync(directory)
        }
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }

  private locked<T>(operation: () => T): T {
    const lock = `${this.dependencies.storagePath}.lock`
    let descriptor: number | undefined
    let result!: T
    let failed = false
    try {
      if (this.storageFailed) throw new Error(STORAGE_ERROR)
      mkdirSync(dirname(lock), { recursive: true })
      // A second process, or a lock left by a crash, must fail closed instead of resetting usage.
      descriptor = openSync(lock, 'wx', 0o600)
      result = operation()
    } catch {
      this.storageFailed = true
      failed = true
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor)
          unlinkSync(lock)
        } catch {
          this.storageFailed = true
          failed = true
        }
      }
    }
    if (failed) throw new Error(STORAGE_ERROR)
    return result
  }

  private view(settings: SavedSettings, month: string): CloudTranslationSettings {
    const usage = settings.months[month] ?? { usedCharacters: 0, externalCharacters: 0 }
    return {
      enabled: settings.enabled,
      hasApiKey: !!settings.encryptedApiKey,
      monthlyLimit: settings.monthlyLimit,
      month,
      usedCharacters: usage.usedCharacters,
      externalCharacters: usage.externalCharacters,
      remainingCharacters: Math.max(
        0,
        settings.monthlyLimit - usage.usedCharacters - usage.externalCharacters,
      ),
    }
  }

  getCloudTranslationSettings(): CloudTranslationSettings {
    const month = monthAt(this.now())
    try {
      return this.view(this.read(), month)
    } catch {
      return {
        ...this.view(emptySettings(), month),
        remainingCharacters: 0,
        storageError: STORAGE_ERROR,
      }
    }
  }

  updateCloudTranslationSettings(patch: CloudTranslationSettingsPatch): CloudTranslationSettings {
    if (
      !patch ||
      typeof patch !== 'object' ||
      (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
      (patch.removeApiKey !== undefined && typeof patch.removeApiKey !== 'boolean') ||
      (patch.monthlyLimit !== undefined &&
        !isCount(patch.monthlyLimit, CLOUD_TRANSLATION_FREE_CHARACTERS)) ||
      (patch.externalCharacters !== undefined &&
        !isCount(patch.externalCharacters, CLOUD_TRANSLATION_FREE_CHARACTERS)) ||
      (patch.apiKey !== undefined &&
        (typeof patch.apiKey !== 'string' ||
          (patch.apiKey.trim() !== '' && !/^[\x21-\x7e]{1,4096}$/.test(patch.apiKey.trim()))))
    )
      throw new Error('Google Cloud 설정 값이 올바르지 않습니다.')
    const key = patch.apiKey?.trim()
    if (key && patch.removeApiKey)
      throw new Error('API 키 저장과 삭제를 동시에 요청할 수 없습니다.')
    let encryptedKey: string | undefined
    if (key) {
      try {
        if (!this.dependencies.encryption.isEncryptionAvailable()) throw new Error()
        encryptedKey = this.dependencies.encryption.encryptString(key).toString('base64')
      } catch {
        throw new Error('Windows 보안 저장소로 API 키를 암호화할 수 없습니다.')
      }
    }
    return this.locked(() => {
      const settings = this.read()
      const month = monthAt(this.now())
      if (patch.enabled !== undefined) settings.enabled = patch.enabled
      if (patch.monthlyLimit !== undefined) settings.monthlyLimit = patch.monthlyLimit
      if (encryptedKey) settings.encryptedApiKey = encryptedKey
      if (patch.removeApiKey) delete settings.encryptedApiKey
      if (patch.externalCharacters !== undefined) {
        const usage = settings.months[month] ?? { usedCharacters: 0, externalCharacters: 0 }
        settings.months[month] = { ...usage, externalCharacters: patch.externalCharacters }
      }
      this.write(settings)
      return this.view(settings, month)
    })
  }

  async translateWithCloud(
    text: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<CloudTranslationResult> {
    if (signal?.aborted) throw createAbortError()
    if (typeof text !== 'string' || text.trim() === '')
      return { ok: false, reason: '번역할 내용이 없습니다.' }
    const characters = Array.from(text).length
    const body = JSON.stringify({
      q: text,
      target: 'ko',
      format: 'text',
      model: 'nmt',
      ...(typeof language === 'string' &&
      language !== 'auto' &&
      /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)
        ? { source: language }
        : {}),
    })
    // Basic v2 accepts at most 100K bytes; billing still counts only the source's code points.
    if (Buffer.byteLength(body, 'utf8') > 100_000)
      return { ok: false, reason: 'Google Cloud 한 번의 번역 길이를 초과했습니다.' }
    let apiKey: string | undefined
    let unavailable: CloudTranslationResult | undefined
    try {
      this.locked(() => {
        const settings = this.read()
        if (!settings.enabled || !settings.encryptedApiKey) {
          unavailable = { ok: false, reason: 'Google Cloud가 꺼져 있거나 API 키가 없습니다.' }
          return
        }
        if (!this.dependencies.encryption.isEncryptionAvailable()) {
          unavailable = { ok: false, reason: 'Google Cloud API 키를 안전하게 읽을 수 없습니다.' }
          return
        }
        try {
          apiKey = this.dependencies.encryption.decryptString(
            Buffer.from(settings.encryptedApiKey, 'base64'),
          )
        } catch {
          unavailable = { ok: false, reason: 'Google Cloud API 키를 안전하게 읽을 수 없습니다.' }
          return
        }
        if (!apiKey || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) {
          unavailable = { ok: false, reason: 'Google Cloud API 키를 안전하게 읽을 수 없습니다.' }
          return
        }
        const dispatchTime = this.now()
        const month = monthAt(dispatchTime)
        // Keep a 30-second gap around the closing month so a 20-second request cannot spend the next month's credit.
        if (monthAt(new Date(dispatchTime.getTime() + 30_000)) !== month) {
          unavailable = {
            ok: false,
            reason: 'Google Cloud 월별 한도 갱신 시간에는 Ollama를 사용합니다.',
          }
          return
        }
        const usage = settings.months[month] ?? { usedCharacters: 0, externalCharacters: 0 }
        if (characters > settings.monthlyLimit - usage.usedCharacters - usage.externalCharacters) {
          unavailable = {
            ok: false,
            reason: 'Google Cloud의 이번 달 무료 한도를 모두 사용했습니다.',
          }
          return
        }
        settings.months[month] = { ...usage, usedCharacters: usage.usedCharacters + characters }
        // Reserve and fsync before sending. Errors, timeouts and cancellation never refund uncertain charges.
        this.write(settings)
      })
    } catch {
      return { ok: false, reason: STORAGE_ERROR }
    }
    if (unavailable) return unavailable
    if (!apiKey) return { ok: false, reason: 'Google Cloud API 키를 안전하게 읽을 수 없습니다.' }
    if (signal?.aborted) throw createAbortError()
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.request(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-goog-api-key': apiKey },
        body,
        signal: controller.signal,
      })
      if (signal?.aborted) throw createAbortError()
      if (!response.ok) {
        return {
          ok: false,
          reason:
            response.status === 401 || response.status === 403
              ? 'Google Cloud 인증, 결제 설정 또는 사용량 제한을 확인하세요.'
              : response.status === 429
                ? 'Google Cloud 요청 한도에 도달했습니다.'
                : 'Google Cloud 번역 요청에 실패했습니다.',
        }
      }
      const data = (await response.json()) as {
        data?: { translations?: { translatedText?: unknown }[] }
      }
      if (signal?.aborted) throw createAbortError()
      if (controller.signal.aborted)
        return { ok: false, reason: 'Google Cloud 번역 응답 시간이 초과되었습니다.' }
      const translations = data?.data?.translations
      const translated =
        Array.isArray(translations) && translations.length === 1
          ? translations[0]?.translatedText
          : undefined
      if (typeof translated !== 'string' || !translated.trim())
        return { ok: false, reason: 'Google Cloud가 올바른 번역을 반환하지 않았습니다.' }
      // Python's html.unescape decodes the API's HTML entities exactly once before writing the SRT.
      return { ok: true, text: translated.trim() }
    } catch {
      if (signal?.aborted) throw createAbortError()
      return {
        ok: false,
        reason: controller.signal.aborted
          ? 'Google Cloud 번역 응답 시간이 초과되었습니다.'
          : 'Google Cloud 번역에 연결할 수 없습니다.',
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

let service: CloudTranslationService | undefined
function currentService(): CloudTranslationService {
  service ??= new CloudTranslationService({
    storagePath: join(app.getPath('userData'), 'cloud-translation.json'),
    encryption: safeStorage,
  })
  return service
}

export function getCloudTranslationSettings(): CloudTranslationSettings {
  return currentService().getCloudTranslationSettings()
}

export function updateCloudTranslationSettings(
  patch: CloudTranslationSettingsPatch,
): CloudTranslationSettings {
  return currentService().updateCloudTranslationSettings(patch)
}

export function translateWithCloud(
  text: string,
  language: string,
  signal?: AbortSignal,
): Promise<CloudTranslationResult> {
  return currentService().translateWithCloud(text, language, signal)
}
