import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => 'unused' }, safeStorage: {} }))
import { StashMetadataService, stashEndpoint } from './StashMetadataService'

let directory: string
let storagePath: string
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(`encrypted:${text.split('').reverse().join('')}`),
  decryptString: (bytes: Buffer) =>
    bytes.toString().slice('encrypted:'.length).split('').reverse().join(''),
}
const payload = {
  data: {
    findScenes: {
      count: 1,
      scenes: [
        {
          id: '42',
          title: 'Title',
          details: '<script>text only</script>',
          code: 'CODE-42',
          date: '2026-01-01',
          studio: { name: 'Studio' },
          tags: [{ name: 'Category' }],
          performers: [{ name: 'Person' }],
        },
      ],
    },
  },
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dvm-stash-'))
  storagePath = join(directory, 'stash-metadata.json')
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
function setup(
  request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload))),
) {
  const service = new StashMetadataService({
    storagePath,
    encryption,
    fetch: request,
    timeoutMs: 50,
  })
  service.updateSettings({
    enabled: true,
    serverUrl: 'http://localhost:9999',
    apiKey: 'YOUR_STASH_API_KEY',
  })
  return { service, request }
}

describe('Stash metadata connection', () => {
  it('defaults off, never queries during settings reads/writes, and returns no key', async () => {
    const request = vi.fn<typeof fetch>()
    const service = new StashMetadataService({ storagePath, encryption, fetch: request })
    expect(service.getSettings()).toEqual({ enabled: false, serverUrl: '', hasApiKey: false })
    await expect(service.search('CODE-42')).rejects.toThrow('켜주세요')
    expect(
      service.updateSettings({
        enabled: true,
        serverUrl: 'https://stash.example',
        apiKey: 'YOUR_STASH_API_KEY',
      }),
    ).toEqual({ enabled: true, serverUrl: 'https://stash.example/graphql', hasApiKey: true })
    expect(readFileSync(storagePath, 'utf8')).not.toContain('YOUR_STASH_API_KEY')
    expect(request).not.toHaveBeenCalled()
  })
  it('accepts HTTPS subpaths and only loopback HTTP, rejects credentials and URL payloads', () => {
    expect(stashEndpoint('https://stash.example/stash/')).toBe(
      'https://stash.example/stash/graphql',
    )
    expect(stashEndpoint('http://[::1]:9999/graphql')).toBe('http://[::1]:9999/graphql')
    const credentialUrl = new URL('https://stash.example')
    credentialUrl.username = 'user'
    credentialUrl.password = 'YOUR_PASSWORD'
    for (const input of [
      'http://192.168.1.4:9999',
      'http://example.com',
      'file:///tmp/api',
      credentialUrl.href,
      'https://stash.example/?key=secret',
      'https://stash.example/#fragment',
      'http://localhost.evil.example',
    ])
      expect(() => stashEndpoint(input)).toThrow()
  })
  it('sends a bounded read-only query only to the configured endpoint and maps supported fields', async () => {
    const { service, request } = setup()
    const result = await service.search(' CODE-42 ')
    const [url, options] = request.mock.calls[0]
    expect(url).toBe('http://localhost:9999/graphql')
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { ApiKey: 'YOUR_STASH_API_KEY' },
    })
    expect(JSON.parse(options!.body as string).variables).toEqual({
      filter: { q: 'CODE-42', page: 1, per_page: 20 },
    })
    expect(JSON.parse(options!.body as string).query).not.toMatch(
      /mutation|scrape|screenshot|paths/,
    )
    expect(result).toEqual({
      total: 1,
      candidates: [
        {
          id: '42',
          title: 'Title',
          description: '<script>text only</script>',
          code: 'CODE-42',
          date: '2026-01-01',
          studio: 'Studio',
          tags: ['Category'],
          people: ['Person'],
        },
      ],
    })
  })
  it('drops the saved key when the destination changes and supports explicit key deletion', async () => {
    const { service, request } = setup()
    service.updateSettings({ enabled: true, serverUrl: 'https://another.example' })
    expect(service.getSettings().hasApiKey).toBe(false)
    await service.search('query')
    expect(request.mock.calls[0][1]?.headers).not.toHaveProperty('ApiKey')
    service.updateSettings({
      enabled: true,
      serverUrl: 'https://another.example',
      apiKey: 'YOUR_REPLACEMENT_KEY',
    })
    expect(
      service.updateSettings({
        enabled: false,
        serverUrl: 'https://another.example',
        removeApiKey: true,
      }).hasApiKey,
    ).toBe(false)
  })
  it('uses an explicit exact code filter because Stash text search does not search the code column', async () => {
    const { service, request } = setup()
    await service.search('CODE-42', 'code')
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).variables).toEqual({
      filter: { page: 1, per_page: 20 },
      sceneFilter: { code: { value: 'CODE-42', modifier: 'EQUALS' } },
    })
  })
  it('preserves settings when secure storage is unavailable or existing data is corrupt', () => {
    const { service } = setup()
    const before = readFileSync(storagePath, 'utf8')
    const unavailable = new StashMetadataService({
      storagePath,
      encryption: { ...encryption, isEncryptionAvailable: () => false },
    })
    expect(() =>
      unavailable.updateSettings({
        enabled: true,
        serverUrl: 'http://localhost:9999',
        apiKey: 'YOUR_REPLACEMENT_KEY',
      }),
    ).toThrow('보안 저장소')
    expect(readFileSync(storagePath, 'utf8')).toBe(before)
    writeFileSync(storagePath, '{broken')
    expect(() => service.updateSettings({ enabled: false, serverUrl: '' })).toThrow('기존 설정')
    expect(readFileSync(storagePath, 'utf8')).toBe('{broken')
  })
  it('does not reveal upstream GraphQL, HTTP, or network error details', async () => {
    for (const response of [
      new Response(JSON.stringify({ errors: [{ message: 'YOUR_STASH_API_KEY private path' }] })),
      new Response('YOUR_STASH_API_KEY', { status: 401 }),
      new Response('<html>YOUR_STASH_API_KEY</html>'),
    ]) {
      const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(response))
      await expect(service.search('query')).rejects.not.toThrow('YOUR_STASH_API_KEY')
    }
    const { service } = setup(
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('YOUR_STASH_API_KEY https://private-server')),
    )
    await expect(service.search('query')).rejects.not.toThrow('YOUR_STASH_API_KEY')
  })
  it('rejects oversized declared and streamed response bodies', async () => {
    for (const response of [
      new Response('{}', { headers: { 'Content-Length': '1048577' } }),
      new Response('x'.repeat(1024 * 1024 + 1)),
    ]) {
      const { service } = setup(vi.fn<typeof fetch>().mockResolvedValue(response))
      await expect(service.search('query')).rejects.toThrow('크기')
    }
  })
  it('aborts on timeout and when settings are disabled during a query', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    )
    const { service } = setup(request)
    await expect(service.search('query')).rejects.toThrow('제한 시간')
    const pending = service.search('another')
    service.updateSettings({ enabled: false, serverUrl: 'http://localhost:9999' })
    await expect(pending).rejects.toThrow('취소')
  })
  it('does not follow a real HTTP redirect or forward the key to its target', async () => {
    let redirectedRequests = 0
    const server = createServer((request, response) => {
      if (request.url === '/graphql') response.writeHead(302, { Location: '/unexpected' }).end()
      else {
        redirectedRequests++
        response.end(JSON.stringify(payload))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const service = new StashMetadataService({ storagePath, encryption })
      service.updateSettings({
        enabled: true,
        serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: 'YOUR_STASH_API_KEY',
      })
      await expect(service.search('CODE-42')).rejects.toThrow('연결하지 못했습니다')
      expect(redirectedRequests).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
