import { z } from 'zod'

export function hasInvalidFilenameCharacters(value: string): boolean {
  return /[<>:"/\\|?*]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)
}

export const CleanupRuleZ = z
  .object({
    prefix: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !hasInvalidFilenameCharacters(value)),
  })
  .strict()
export type CleanupRule = z.infer<typeof CleanupRuleZ>
export interface RenameFilePreview {
  from: string
  to: string
  kind: 'video' | 'subtitle'
}
export interface RenamePreviewRow {
  videoId: string
  fileName: string
  nextName: string
  files: RenameFilePreview[]
  error?: string
}
export interface RenamePreview {
  id: string
  libraryId: string
  expiresAt: string
  rows: RenamePreviewRow[]
  truncated: boolean
}
export interface RenameResult {
  items: {
    videoId: string
    fileName: string
    status: 'renamed' | 'failed' | 'cancelled'
    message: string
  }[]
  cancelled: boolean
}
export interface DuplicateFile {
  videoId: string
  fileName: string
  filePath: string
  sizeBytes: number
}
export interface DuplicateResult {
  groups: { sha256: string; sizeBytes: number; files: DuplicateFile[] }[]
  checkedFiles: number
  skipped: { videoId: string; fileName: string; reason: string }[]
  cancelled: boolean
}
