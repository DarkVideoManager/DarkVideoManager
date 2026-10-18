import { z } from 'zod'

export const DEFAULT_SUBTITLE_CONCURRENCY = 2
export const SubtitleConcurrencyZ = z.number().int().min(1).max(4)
