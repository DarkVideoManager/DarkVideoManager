import { z } from 'zod'

export const DEFAULT_SEEK_STEP_SEC = 1
export const MIN_SEEK_STEP_SEC = 1
export const MAX_SEEK_STEP_SEC = 600

export const SeekStepSecZ = z.number().finite().int().min(MIN_SEEK_STEP_SEC).max(MAX_SEEK_STEP_SEC)
