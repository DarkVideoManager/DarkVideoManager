import { z } from 'zod'

export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4] as const
export const PlaybackRateZ = z.number().finite().min(0.25).max(4)
