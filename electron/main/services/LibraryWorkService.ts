import { createAbortError } from '../ffmpeg/queue'

export type LibraryWorkKind = 'exclusive' | 'subtitles' | 'thumbnails'

interface ActiveWork {
  kind: LibraryWorkKind
  resourceKey?: string
  controller: AbortController
  finished: Promise<void>
}

const activeWork = new Map<string, Set<ActiveWork>>()
let draining = 0
let shuttingDown = false

export function assertLibraryWorkAllowed(
  libraryId: string,
  kind: LibraryWorkKind = 'exclusive',
  resourceKey?: string,
): void {
  if (shuttingDown || draining > 0)
    throw new Error('앱을 종료하고 있습니다. 작업이 정리될 때까지 기다려 주세요.')
  if (isLibraryWorkBlocked(libraryId, kind, resourceKey))
    throw new Error(
      '이 라이브러리에서 다른 작업이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도하세요.',
    )
}

export function isLibraryWorkBlocked(
  libraryId: string,
  kind: LibraryWorkKind = 'exclusive',
  resourceKey?: string,
): boolean {
  if (shuttingDown || draining > 0) return true
  // Different videos may queue thumbnail work together. Unscoped mutations and
  // same-video writes remain serialized; imports and closure stay exclusive.
  for (const active of activeWork.get(libraryId) ?? []) {
    if (
      active.controller.signal.aborted ||
      kind === 'exclusive' ||
      active.kind === 'exclusive' ||
      (active.kind === kind &&
        (kind !== 'thumbnails' ||
          !resourceKey ||
          !active.resourceKey ||
          active.resourceKey === resourceKey))
    )
      return true
  }
  return false
}

export async function withLibraryWork<T>(
  libraryId: string,
  work: (signal: AbortSignal) => Promise<T>,
  kind: LibraryWorkKind = 'exclusive',
  resourceKey?: string,
): Promise<T> {
  assertLibraryWorkAllowed(libraryId, kind, resourceKey)
  const controller = new AbortController()
  let finish!: () => void
  const active = {
    kind,
    resourceKey,
    controller,
    finished: new Promise<void>((resolve) => {
      finish = resolve
    }),
  }
  const jobs = activeWork.get(libraryId) ?? new Set<ActiveWork>()
  jobs.add(active)
  activeWork.set(libraryId, jobs)
  try {
    return await work(controller.signal)
  } finally {
    jobs.delete(active)
    if (jobs.size === 0) activeWork.delete(libraryId)
    finish()
  }
}

export function cancelLibraryWork(libraryId: string): boolean {
  let cancelled = false
  for (const { controller } of activeWork.get(libraryId) ?? []) {
    if (controller.signal.aborted) continue
    controller.abort()
    cancelled = true
  }
  return cancelled
}

export function isLibraryBusy(libraryId: string): boolean {
  return shuttingDown || draining > 0 || activeWork.has(libraryId)
}

export function cancelAllLibraryWork(): void {
  for (const libraryId of activeWork.keys()) cancelLibraryWork(libraryId)
}

export async function drainLibraryWork(options: { shutdown?: boolean } = {}): Promise<void> {
  // Block new work while cancellation unwinds each job's asynchronous cleanup.
  if (options.shutdown) shuttingDown = true
  draining++
  try {
    cancelAllLibraryWork()
    await Promise.all(
      [...activeWork.values()].flatMap((jobs) => [...jobs].map(({ finished }) => finished)),
    )
  } finally {
    draining--
  }
}

export function throwIfWorkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

export async function yieldLibraryWork(signal?: AbortSignal): Promise<void> {
  throwIfWorkCancelled(signal)
  await new Promise<void>((resolve) => setImmediate(resolve))
  throwIfWorkCancelled(signal)
}
