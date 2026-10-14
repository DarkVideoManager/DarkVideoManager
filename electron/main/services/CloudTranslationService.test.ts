import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'unused' }, safeStorage: {} }))

import { CloudTranslationService } from './CloudTranslationService'

const API_KEY = 'synthetic-test-api-key'
let root: string
let storagePath: string
let now: Date
let encryption: {
  isEncryptionAvailable: ReturnType<typeof vi.fn<() => boolean>>
  encryptString: ReturnType<typeof vi.fn<(value: string) => Buffer>>
  decryptString: ReturnType<typeof vi.fn<(value: Buffer) => string>>
}
let request: ReturnType<typeof vi.fn>
let service: CloudTranslationService

function response(translatedText = '번역 결과', status = 200) {
  return new Response(JSON.stringify({ data: { translations: [{ translatedText }] } }), { status })
}

function createService(timeoutMs?: number) {
  return new CloudTranslationService({
    storagePath,
    encryption,
    fetch: request as typeof fetch,
    now: () => now,
    timeoutMs,
  })
}

function configure(monthlyLimit = 500_000, externalCharacters = 0) {
  return service.updateCloudTranslationSettings({
    enabled: true,
    apiKey: API_KEY,
    monthlyLimit,
    externalCharacters,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dvm-cloud-translation-'))
  storagePath = join(root, 'cloud-translation.json')
  now = new Date('2026-10-10T12:00:00Z')
  encryption = {
    isEncryptionAvailable: vi.fn(() => true),
    // A reversible test double stands in for the Windows DPAPI-backed safeStorage implementation.
    encryptString: vi.fn((value: string) =>
      Buffer.from(`protected:${[...value].reverse().join('')}`),
    ),
    decryptString: vi.fn((value: Buffer) =>
      [...value.toString().slice('protected:'.length)].reverse().join(''),
    ),
  }
  request = vi.fn(async () => response())
  service = createService()
})

afterEach(() => {
  vi.useRealTimers()
  const directory = resolve(root)
  if (
    !directory.startsWith(resolve(tmpdir()) + sep) ||
    !directory.includes('dvm-cloud-translation-')
  )
    throw new Error('Unsafe cleanup path')
  rmSync(directory, { recursive: true, force: true })
})

describe('Google Cloud Translation monthly credit guard', () => {
  it('starts disabled without a key and makes no network request', async () => {
    expect(service.getCloudTranslationSettings()).toEqual({
      enabled: false,
      hasApiKey: false,
      monthlyLimit: 500_000,
      month: '2026-10',
      usedCharacters: 0,
      externalCharacters: 0,
      remainingCharacters: 500_000,
    })
    expect(await service.translateWithCloud('Hello', 'en')).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('encrypts the key at rest and never returns it through settings', () => {
    const settings = configure()
    expect(settings.hasApiKey).toBe(true)
    expect(encryption.encryptString).toHaveBeenCalledWith(API_KEY)
    expect(readFileSync(storagePath, 'utf8')).not.toContain(API_KEY)
    expect(JSON.stringify(settings)).not.toContain(API_KEY)
    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).not.toHaveProperty('apiKey')
    expect(createService().getCloudTranslationSettings()).toEqual(settings)
  })

  it('reserves Unicode code points including whitespace durably before sending at the exact limit', async () => {
    configure(8, 2)
    const text = 'あ😀 e\u0301\n' // Six code points; the emoji is two UTF-16 code units.
    request.mockImplementationOnce(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://translation.googleapis.com/language/translate/v2')
      expect(url).not.toContain(API_KEY)
      expect(init.redirect).toBe('error')
      expect(init.headers).toMatchObject({ 'x-goog-api-key': API_KEY })
      expect(JSON.parse(init.body as string)).toEqual({
        q: text,
        target: 'ko',
        source: 'ja',
        format: 'text',
        model: 'nmt',
      })
      expect(JSON.parse(readFileSync(storagePath, 'utf8')).months['2026-10'].usedCharacters).toBe(6)
      return response('A &amp; B &#39;말&#39;')
    })
    // Entity decoding is intentionally left to the worker, exactly once.
    expect(await service.translateWithCloud(text, 'ja')).toEqual({
      ok: true,
      text: 'A &amp; B &#39;말&#39;',
    })
    expect(service.getCloudTranslationSettings()).toMatchObject({
      usedCharacters: 6,
      externalCharacters: 2,
      remainingCharacters: 0,
    })
    expect(await service.translateWithCloud('x', 'en')).toMatchObject({ ok: false })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not partially send a cue that exceeds the remaining budget', async () => {
    configure(3)
    expect(await service.translateWithCloud('1234', 'en')).toMatchObject({ ok: false })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('checks the Basic API request byte limit before reserving billable characters', async () => {
    configure()
    expect(await service.translateWithCloud('😀'.repeat(25_000), 'en')).toMatchObject({ ok: false })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('omits an automatic or invalid source without making an extra detection call', async () => {
    configure()
    await service.translateWithCloud('text', 'auto')
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty('source')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('cannot overshoot through concurrent requests or separate service instances', async () => {
    configure(3)
    const other = createService()
    const results = await Promise.all([
      service.translateWithCloud('ab', 'en'),
      other.translateWithCloud('cd', 'en'),
      service.translateWithCloud('ef', 'en'),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(1)
    expect(other.getCloudTranslationSettings()).toMatchObject({
      usedCharacters: 2,
      remainingCharacters: 1,
    })
  })

  it('preserves used characters through disabling, empty keys, replacing and removing keys, and restart', async () => {
    configure()
    await service.translateWithCloud('hello', 'en')
    service.updateCloudTranslationSettings({ enabled: false, apiKey: '' })
    expect(service.getCloudTranslationSettings()).toMatchObject({
      usedCharacters: 5,
      hasApiKey: true,
    })
    service.updateCloudTranslationSettings({ enabled: true, apiKey: 'second-synthetic-key' })
    expect(service.getCloudTranslationSettings()).toMatchObject({ usedCharacters: 5 })
    service.updateCloudTranslationSettings({ removeApiKey: true })
    service = createService()
    expect(service.getCloudTranslationSettings()).toMatchObject({
      usedCharacters: 5,
      hasApiKey: false,
    })
    service.updateCloudTranslationSettings({ apiKey: API_KEY })
    await service.translateWithCloud('world', 'en')
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(10)
  })

  it('deducts external usage and a lowered app budget without resetting usage', async () => {
    configure(10)
    await service.translateWithCloud('hello', 'en')
    service.updateCloudTranslationSettings({ monthlyLimit: 8, externalCharacters: 3 })
    expect(service.getCloudTranslationSettings()).toMatchObject({
      usedCharacters: 5,
      externalCharacters: 3,
      remainingCharacters: 0,
    })
    expect(await service.translateWithCloud('x', 'en')).toMatchObject({ ok: false })
    service.updateCloudTranslationSettings({ monthlyLimit: 0 })
    expect(service.getCloudTranslationSettings().remainingCharacters).toBe(0)
  })

  it('uses the Pacific billing month and keeps old counts if the clock rolls back', async () => {
    now = new Date('2026-11-01T06:58:00Z') // October 31, 23:58 PDT, despite November in UTC/Korea.
    configure(10, 2)
    await service.translateWithCloud('hello', 'en')
    expect(service.getCloudTranslationSettings()).toMatchObject({
      month: '2026-10',
      usedCharacters: 5,
    })
    now = new Date('2026-11-01T07:00:00Z')
    expect(service.getCloudTranslationSettings()).toMatchObject({
      month: '2026-11',
      usedCharacters: 0,
      externalCharacters: 0,
      remainingCharacters: 10,
    })
    await service.translateWithCloud('world', 'en')
    now = new Date('2026-11-01T06:58:00Z')
    expect(createService().getCloudTranslationSettings()).toMatchObject({
      month: '2026-10',
      usedCharacters: 5,
      externalCharacters: 2,
      remainingCharacters: 3,
    })
  })

  it('does not dispatch in the final 30 seconds of a month', async () => {
    now = new Date('2026-11-01T06:59:35Z')
    configure()
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([-1, 500_001, 0.5, NaN, Infinity])(
    'rejects invalid monthly and external limits: %s',
    (limit) => {
      expect(() => service.updateCloudTranslationSettings({ monthlyLimit: limit })).toThrow(
        '설정 값',
      )
      expect(() => service.updateCloudTranslationSettings({ externalCharacters: limit })).toThrow(
        '설정 값',
      )
      expect(existsSync(storagePath)).toBe(false)
    },
  )

  it.each([401, 403, 429, 500])('falls back without retry or refund on HTTP %s', async (status) => {
    configure()
    request.mockResolvedValueOnce(new Response(`provider body with ${API_KEY}`, { status }))
    const result = await service.translateWithCloud('hello', 'en')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(request).toHaveBeenCalledTimes(1)
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(5)
  })

  it('keeps the reservation after a network error and does not expose provider exceptions', async () => {
    configure()
    request.mockRejectedValueOnce(new Error(`network error including ${API_KEY}`))
    const result = await service.translateWithCloud('hello', 'en')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(5)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each([
    {},
    { data: {} },
    { data: { translations: [] } },
    { data: { translations: [{ translatedText: '' }] } },
    { data: { translations: [{ translatedText: 12 }] } },
  ])('rejects malformed successful responses without refund', async (data) => {
    configure()
    request.mockResolvedValueOnce(new Response(JSON.stringify(data)))
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(5)
  })

  it('does not reserve or send when already canceled', async () => {
    configure()
    const controller = new AbortController()
    controller.abort()
    await expect(
      service.translateWithCloud('hello', 'en', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })

  it('cancels an in-flight request while keeping its reservation', async () => {
    configure()
    const controller = new AbortController()
    request.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error(API_KEY)), { once: true })
        }),
    )
    const pending = service.translateWithCloud('hello', 'en', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(5)
  })

  it('times out once and keeps the reservation', async () => {
    vi.useFakeTimers()
    configure()
    request.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error(API_KEY)), { once: true })
        }),
    )
    const pending = service.translateWithCloud('hello', 'en')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await pending).toMatchObject({
      ok: false,
      reason: expect.stringContaining('시간이 초과'),
    })
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(5)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('fails closed on corrupt usage without resetting or rewriting the file', async () => {
    const corrupt = '{"version":1,"enabled":true,"months":'
    writeFileSync(storagePath, corrupt)
    expect(service.getCloudTranslationSettings()).toMatchObject({
      remainingCharacters: 0,
      storageError: expect.any(String),
    })
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(() => service.updateCloudTranslationSettings({ apiKey: API_KEY })).toThrow('사용량 기록')
    expect(readFileSync(storagePath, 'utf8')).toBe(corrupt)
    expect(request).not.toHaveBeenCalled()
  })

  it('fails closed on invalid or unsupported ledger contents', async () => {
    configure()
    const saved = JSON.parse(readFileSync(storagePath, 'utf8'))
    saved.months['2026-10'].usedCharacters = -1
    writeFileSync(storagePath, JSON.stringify(saved))
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
    expect(service.getCloudTranslationSettings().storageError).toBeTruthy()
  })

  it('fails closed if a previously observed usage file disappears', async () => {
    configure()
    rmSync(storagePath)
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(service.getCloudTranslationSettings().storageError).toBeTruthy()
    expect(existsSync(storagePath)).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects unexpected fields instead of exposing them through the sanitized settings view', async () => {
    configure()
    const saved = JSON.parse(readFileSync(storagePath, 'utf8'))
    saved.months['2026-10'].apiKey = API_KEY
    writeFileSync(storagePath, JSON.stringify(saved))
    const settings = service.getCloudTranslationSettings()
    expect(settings.storageError).toBeTruthy()
    expect(JSON.stringify(settings)).not.toContain(API_KEY)
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('does not send if another process holds the ledger lock', async () => {
    configure()
    writeFileSync(`${storagePath}.lock`, 'other process')
    expect(await service.translateWithCloud('hello', 'en')).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(storagePath, 'utf8')).months['2026-10'].usedCharacters).toBe(0)
    expect(readFileSync(`${storagePath}.lock`, 'utf8')).toBe('other process')
  })

  it('never writes a cleartext key when encryption is unavailable or fails', () => {
    encryption.isEncryptionAvailable.mockReturnValue(false)
    expect(() => configure()).toThrow('암호화')
    expect(existsSync(storagePath)).toBe(false)
    encryption.isEncryptionAvailable.mockReturnValue(true)
    encryption.encryptString.mockImplementationOnce(() => {
      throw new Error(API_KEY)
    })
    let error: unknown
    try {
      configure()
    } catch (caught) {
      error = caught
    }
    expect(String(error)).not.toContain(API_KEY)
    expect(existsSync(storagePath)).toBe(false)
  })

  it('falls back without spending if the stored key cannot be decrypted', async () => {
    configure()
    encryption.decryptString.mockImplementationOnce(() => {
      throw new Error(API_KEY)
    })
    const result = await service.translateWithCloud('hello', 'en')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(API_KEY)
    expect(service.getCloudTranslationSettings().usedCharacters).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })
})
