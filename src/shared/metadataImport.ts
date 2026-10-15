import { z } from 'zod'

export const StashSettingsPatchZ = z
  .object({
    enabled: z.boolean(),
    serverUrl: z.string().max(2048),
    apiKey: z.string().max(4096).optional(),
    removeApiKey: z.boolean().optional(),
  })
  .strict()

export interface StashSettings {
  enabled: boolean
  serverUrl: string
  hasApiKey: boolean
}
export type StashSettingsPatch = z.infer<typeof StashSettingsPatchZ>

export const MetadataSearchZ = z.string().trim().min(1).max(200)
export const MetadataSearchModeZ = z.enum(['text', 'code'])
export type MetadataSearchMode = z.infer<typeof MetadataSearchModeZ>
export interface MetadataCandidate {
  id: string
  title: string
  description: string
  tags: string[]
  people: string[]
  studio: string
  date: string
  code: string
}
export interface MetadataSearchResult {
  candidates: MetadataCandidate[]
  total: number
}

// These are the fields supported by the current library schema. Other imported
// classifications can be deliberately mapped to tags in the editable preview.
export const ImportedMetadataZ = z
  .object({
    // Existing libraries have no text-length cap. Snapshots and undo must retain
    // those values exactly; fetched provider data is bounded in the main service.
    title: z.string().nullable(),
    memo: z.string(),
    tags: z.string(),
  })
  .strict()
export const MetadataPatchZ = ImportedMetadataZ.partial().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  '적용할 항목을 선택하세요.',
)
export const MetadataApplyZ = z
  .object({
    expected: ImportedMetadataZ,
    patch: MetadataPatchZ,
  })
  .strict()
export type ImportedMetadata = z.infer<typeof ImportedMetadataZ>
export type MetadataApply = z.infer<typeof MetadataApplyZ>
export interface MetadataApplyResult {
  before: ImportedMetadata
  after: ImportedMetadata
}

export function importedMetadata(video: {
  title?: string | null
  memo: string
  tags: string
}): ImportedMetadata {
  return { title: video.title ?? null, memo: video.memo, tags: video.tags }
}

/** Keep existing comma-separated tags first, then add selected classifications. */
export function mergeImportedTags(existing: string, additions: string[]): string {
  const seen = new Set<string>()
  return [...existing.split(','), ...additions.flatMap((value) => value.split(','))]
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.normalize('NFC').toLocaleLowerCase('en-US')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(', ')
}
