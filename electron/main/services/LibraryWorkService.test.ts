import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertLibraryWorkAllowed,
  cancelAllLibraryWork,
  cancelLibraryWork,
  drainLibraryWork,
  isLibraryBusy,
  isLibraryWorkBlocked,
  withLibraryWork,
  yieldLibraryWork,
  type LibraryWorkKind,
} from './LibraryWorkService'

afterEach(() => cancelAllLibraryWork())

describe('library work lifecycle', () => {
  it.each(['thumbnails', 'subtitles'] as const)(
    'allows different %s videos but blocks same-video, unscoped and exclusive work',
    async (kind) => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = withLibraryWork('scoped', () => held, kind, 'first')
      const second = withLibraryWork('scoped', () => held, kind, 'second')
      try {
        expect(isLibraryWorkBlocked('scoped', kind, 'third')).toBe(false)
        expect(isLibraryWorkBlocked('scoped', kind, 'first')).toBe(true)
        expect(isLibraryWorkBlocked('scoped', kind)).toBe(true)
        expect(isLibraryWorkBlocked('scoped')).toBe(true)
        await expect(withLibraryWork('scoped', async () => 1, kind, 'first')).rejects.toThrow(
          '다른 작업',
        )
        await expect(withLibraryWork('scoped', async () => 1)).rejects.toThrow('다른 작업')
      } finally {
        release()
        await Promise.all([first, second])
      }
      expect(isLibraryBusy('scoped')).toBe(false)
    },
  )

  it('drains cancellation cleanup before allowing more jobs', async () => {
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let cleaned = false
    const work = withLibraryWork('shutdown', async (signal) => {
      try {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        await yieldLibraryWork(signal)
      } finally {
        await cleanup
        cleaned = true
      }
    })
    const outcome = work.catch((error: Error) => error.name)
    let drained = false
    const drain = drainLibraryWork().then(() => {
      drained = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(drained).toBe(false)
    expect(cleaned).toBe(false)
    await expect(withLibraryWork('new-library', async () => 1)).rejects.toThrow('종료')
    releaseCleanup()
    await drain
    expect(await outcome).toBe('AbortError')
    expect(cleaned).toBe(true)
    expect(isLibraryBusy('shutdown')).toBe(false)
  })

  it('serializes a library while allowing work in other libraries', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withLibraryWork('one', async () => {
      await held
      return 1
    })
    expect(isLibraryBusy('one')).toBe(true)
    await expect(withLibraryWork('one', async () => 2)).rejects.toThrow('다른 작업')
    expect(await withLibraryWork('two', async () => 2)).toBe(2)
    release()
    expect(await first).toBe(1)
    expect(isLibraryBusy('one')).toBe(false)
  })

  it('keeps cancellation active until outstanding cleanup actually settles', async () => {
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    const work = withLibraryWork('cancel', async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      await cleanup
      await yieldLibraryWork(signal)
    })
    expect(cancelLibraryWork('cancel')).toBe(true)
    expect(cancelLibraryWork('cancel')).toBe(false)
    expect(isLibraryBusy('cancel')).toBe(true)
    release()
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(isLibraryBusy('cancel')).toBe(false)
  })

  it.each([
    ['subtitles', 'thumbnails'],
    ['thumbnails', 'subtitles'],
  ] as const)('allows %s with %s without releasing the remaining job', async (first, second) => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstWork = withLibraryWork(
      'shared',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
      first,
    )
    const secondWork = withLibraryWork(
      'shared',
      () =>
        new Promise<void>((resolve) => {
          releaseSecond = resolve
        }),
      second,
    )
    try {
      expect(isLibraryBusy('shared')).toBe(true)
      for (const kind of ['exclusive', first, second] as const) {
        await expect(withLibraryWork('shared', async () => undefined, kind)).rejects.toThrow(
          '다른 작업',
        )
      }
      releaseFirst()
      await firstWork
      expect(isLibraryBusy('shared')).toBe(true)
      expect(isLibraryWorkBlocked('shared', first)).toBe(false)
      expect(isLibraryWorkBlocked('shared', second)).toBe(true)
      expect(() => assertLibraryWorkAllowed('shared')).toThrow('다른 작업')
    } finally {
      releaseFirst()
      releaseSecond()
      await Promise.all([firstWork, secondWork])
    }
    expect(isLibraryBusy('shared')).toBe(false)
  })

  it('retains exclusive protection against both compatible kinds', async () => {
    await withLibraryWork('exclusive', async () => {
      for (const kind of ['subtitles', 'thumbnails'] as const) {
        expect(isLibraryWorkBlocked('exclusive', kind)).toBe(true)
        await expect(withLibraryWork('exclusive', async () => undefined, kind)).rejects.toThrow(
          '다른 작업',
        )
      }
    })
  })

  it('cancels every job in a library and waits for both cleanups during drain', async () => {
    const releases: Array<() => void> = []
    const signals: AbortSignal[] = []
    const run = (kind: LibraryWorkKind) =>
      withLibraryWork(
        'shared-cancel',
        async (signal) => {
          signals.push(signal)
          await new Promise<void>((resolve) => {
            releases.push(resolve)
          })
          await yieldLibraryWork(signal)
        },
        kind,
      ).catch((error: Error) => error.name)
    const subtitle = run('subtitles')
    const thumbnail = run('thumbnails')
    expect(cancelLibraryWork('shared-cancel')).toBe(true)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(cancelLibraryWork('shared-cancel')).toBe(false)
    let drained = false
    const drain = drainLibraryWork().then(() => {
      drained = true
    })
    try {
      releases[0]()
      expect(await subtitle).toBe('AbortError')
      expect(drained).toBe(false)
      expect(isLibraryBusy('shared-cancel')).toBe(true)
      for (const kind of ['subtitles', 'thumbnails'] as const) {
        expect(() => assertLibraryWorkAllowed('new-library', kind)).toThrow('종료')
        await expect(withLibraryWork('new-library', async () => undefined, kind)).rejects.toThrow(
          '종료',
        )
      }
    } finally {
      releases.forEach((release) => release())
      await drain
    }
    expect(await thumbnail).toBe('AbortError')
    expect(isLibraryBusy('shared-cancel')).toBe(false)
  })

  it('releases failed jobs and broadcasts shutdown cancellation', async () => {
    await expect(
      withLibraryWork('failed', async () => {
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
    expect(isLibraryBusy('failed')).toBe(false)
    const one = withLibraryWork('one', async (signal) => {
      await yieldLibraryWork(signal)
    })
    const two = withLibraryWork('two', async (signal) => {
      await yieldLibraryWork(signal)
    })
    cancelAllLibraryWork()
    const results = await Promise.allSettled([one, two])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(isLibraryBusy('one')).toBe(false)
    expect(isLibraryBusy('two')).toBe(false)
  })

  it('keeps rejecting jobs after the permanent app shutdown drain has finished', async () => {
    vi.resetModules()
    const isolated = await import('./LibraryWorkService')
    await isolated.drainLibraryWork({ shutdown: true })
    expect(isolated.isLibraryBusy('later')).toBe(true)
    await expect(isolated.withLibraryWork('later', async () => 1)).rejects.toThrow('종료')
    // A later ordinary drain must not reopen a coordinator already shutting down.
    await isolated.drainLibraryWork()
    await expect(isolated.withLibraryWork('later', async () => 1)).rejects.toThrow('종료')
  })
})
