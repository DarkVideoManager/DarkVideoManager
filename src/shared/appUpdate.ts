import { z } from 'zod'

export const AppUpdateStateZ = z.object({
  revision: z.number().int().nonnegative(),
  mode: z.enum(['installer', 'portable', 'unpacked', 'development']),
  phase: z.enum([
    'idle',
    'checking',
    'up-to-date',
    'available',
    'downloading',
    'ready',
    'installing',
    'error',
    'unsupported',
  ]),
  currentVersion: z.string().min(1),
  availableVersion: z.string().min(1).optional(),
  automatic: z.boolean(),
  checkedAt: z.string().optional(),
  progress: z
    .object({
      percent: z.number().finite().min(0).max(100),
      transferred: z.number().finite().nonnegative(),
      total: z.number().finite().nonnegative(),
    })
    .optional(),
  error: z.string().optional(),
})

export type AppUpdateState = z.infer<typeof AppUpdateStateZ>
