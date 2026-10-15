import { app, safeStorage } from 'electron'
import {
  closeSync,
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
import { z } from 'zod'
import {
  MetadataSearchZ,
  MetadataSearchModeZ,
  type MetadataSearchMode,
  StashSettingsPatchZ,
  type MetadataSearchResult,
  type StashSettings,
  type StashSettingsPatch,
} from '@shared/metadataImport'

const STORAGE_ERROR =
  'Stash 연결 설정을 안전하게 읽거나 저장할 수 없습니다. 기존 설정 파일을 확인하세요.'
const SavedSettingsZ = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    serverUrl: z.string().max(2048),
    encryptedApiKey: z.string().max(32_768).optional(),
  })
  .strict()
type SavedSettings = z.infer<typeof SavedSettingsZ>
interface Dependencies {
  storagePath: string
  encryption: Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Only the explicitly configured destination receives queries or credentials. */
export function stashEndpoint(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Stash 서버 주소를 확인하세요.')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'HTTPS 주소 또는 로컬 HTTP 주소만 사용할 수 있습니다. 주소에 인증 정보·쿼리·프래그먼트를 넣지 마세요.',
    )
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/graphql') ? path : `${path}/graphql`
  return url.toString()
}

// Official Stash (not Stash-box) GraphQL schema:
// https://github.com/stashapp/stash/tree/develop/graphql/schema
const QUERY = `query DvmMetadata($filter: FindFilterType!, $sceneFilter: SceneFilterType) {
  findScenes(filter: $filter, scene_filter: $sceneFilter) {
    count scenes { id title details code date studio { name } tags { name } performers { name } }
  }
}`
const NameZ = z.object({ name: z.string().max(1000) })
const ResponseZ = z.object({
  data: z.object({
    findScenes: z.object({
      count: z.number().int().nonnegative(),
      scenes: z
        .array(
          z.object({
            id: z.string().max(200),
            title: z.string().max(1000).nullish(),
            details: z.string().max(50_000).nullish(),
            code: z.string().max(1000).nullish(),
            date: z.string().max(100).nullish(),
            studio: NameZ.nullish(),
            tags: z.array(NameZ).max(300),
            performers: z.array(NameZ).max(100),
          }),
        )
        .max(20),
    }),
  }),
})

export class StashMetadataService {
  private active = new Set<AbortController>()
  private hasSeenFile = false
  constructor(private readonly dependencies: Dependencies) {}

  private read(): SavedSettings {
    try {
      const saved = SavedSettingsZ.parse(
        JSON.parse(readFileSync(this.dependencies.storagePath, 'utf8')),
      )
      if (saved.serverUrl) stashEndpoint(saved.serverUrl)
      this.hasSeenFile = true
      return saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.hasSeenFile)
        return { version: 1, enabled: false, serverUrl: '' }
      throw new Error(STORAGE_ERROR)
    }
  }

  private publicSettings(saved: SavedSettings): StashSettings {
    return {
      enabled: saved.enabled,
      serverUrl: saved.serverUrl,
      hasApiKey: Boolean(saved.encryptedApiKey),
    }
  }
  getSettings(): StashSettings {
    return this.publicSettings(this.read())
  }

  updateSettings(input: StashSettingsPatch): StashSettings {
    const patch = StashSettingsPatchZ.parse(input)
    const current = this.read()
    const serverUrl = patch.serverUrl.trim() ? stashEndpoint(patch.serverUrl) : ''
    if (patch.enabled && !serverUrl) throw new Error('Stash 서버 주소를 입력하세요.')
    const next: SavedSettings = { ...current, serverUrl, enabled: patch.enabled }
    // Never forward a key saved for a previous server to a newly entered server.
    if (current.serverUrl !== serverUrl || patch.removeApiKey) delete next.encryptedApiKey
    if (patch.apiKey?.trim()) {
      if (!this.dependencies.encryption.isEncryptionAvailable())
        throw new Error('보안 저장소를 사용할 수 없어 API 키를 저장하지 않았습니다.')
      try {
        next.encryptedApiKey = this.dependencies.encryption
          .encryptString(patch.apiKey.trim())
          .toString('base64')
      } catch {
        throw new Error('API 키를 암호화하지 못했습니다.')
      }
    }
    const file = this.dependencies.storagePath
    const temporary = `${file}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      mkdirSync(dirname(file), { recursive: true })
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, JSON.stringify(next), 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, file)
      this.hasSeenFile = true
    } catch {
      throw new Error(STORAGE_ERROR)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      try {
        unlinkSync(temporary)
      } catch {
        /* renamed or failed before opening */
      }
    }
    for (const controller of this.active) controller.abort()
    return this.publicSettings(next)
  }

  async search(
    input: string,
    searchMode: MetadataSearchMode = 'text',
  ): Promise<MetadataSearchResult> {
    const query = MetadataSearchZ.parse(input)
    const mode = MetadataSearchModeZ.parse(searchMode)
    const saved = this.read()
    if (!saved.enabled || !saved.serverUrl)
      throw new Error('Stash 연결을 설정하고 사용을 켜주세요.')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (saved.encryptedApiKey) {
      try {
        if (!this.dependencies.encryption.isEncryptionAvailable()) throw new Error()
        headers.ApiKey = this.dependencies.encryption.decryptString(
          Buffer.from(saved.encryptedApiKey, 'base64'),
        )
      } catch {
        throw new Error('저장한 API 키를 읽지 못했습니다. 키를 다시 저장하세요.')
      }
    }
    const controller = new AbortController()
    this.active.add(controller)
    const timer = setTimeout(() => controller.abort(), this.dependencies.timeoutMs ?? 15_000)
    try {
      const response = await (this.dependencies.fetch ?? globalThis.fetch)(
        stashEndpoint(saved.serverUrl),
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: QUERY,
            variables:
              mode === 'code'
                ? {
                    filter: { per_page: 20, page: 1 },
                    sceneFilter: { code: { value: query, modifier: 'EQUALS' } },
                  }
                : { filter: { q: query, per_page: 20, page: 1 } },
          }),
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        },
      )
      if (!response.ok)
        throw new Error('Stash 조회에 실패했습니다. 서버 주소와 API 키를 확인하세요.')
      const maxBytes = 1024 * 1024
      if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error('Stash 응답 크기가 제한을 초과했습니다.')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        let chunk = await reader.read()
        while (!chunk.done) {
          const value = chunk.value
          length += value.byteLength
          if (length > maxBytes) throw new Error('Stash 응답 크기가 제한을 초과했습니다.')
          chunks.push(value)
          chunk = await reader.read()
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
      let parsed: z.infer<typeof ResponseZ>
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body.errors?.length) throw new Error()
        parsed = ResponseZ.parse(body)
      } catch {
        throw new Error('Stash 응답을 해석하지 못했습니다. Stash 서버와 API 버전을 확인하세요.')
      }
      if (controller.signal.aborted) throw new Error()
      return {
        total: parsed.data.findScenes.count,
        candidates: parsed.data.findScenes.scenes.map((scene) => ({
          id: scene.id,
          title: scene.title ?? '',
          description: scene.details ?? '',
          tags: scene.tags.map((tag) => tag.name),
          people: scene.performers.map((person) => person.name),
          studio: scene.studio?.name ?? '',
          date: scene.date ?? '',
          code: scene.code ?? '',
        })),
      }
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('Stash 조회가 취소되었거나 제한 시간을 초과했습니다.')
      // Do not surface provider errors or fetch causes: they may contain a key,
      // submitted filename, or the server's private diagnostics.
      if (error instanceof Error && error.message.startsWith('Stash ')) throw error
      throw new Error('Stash 서버에 연결하지 못했습니다. 주소·인증서·연결 상태를 확인하세요.')
    } finally {
      clearTimeout(timer)
      this.active.delete(controller)
    }
  }
}

let service: StashMetadataService | undefined
export function getStashMetadataService(): StashMetadataService {
  return (service ??= new StashMetadataService({
    storagePath: join(app.getPath('userData'), 'stash-metadata.json'),
    encryption: safeStorage,
  }))
}
