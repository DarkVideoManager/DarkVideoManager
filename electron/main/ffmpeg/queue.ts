export type Task<T> = (signal?: AbortSignal) => Promise<T>

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort: () => void
}

export function createAbortError(): Error {
  const error = new Error('작업이 취소되었습니다.')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

export class ConcurrencyQueue {
  private running = 0
  private waiting: Waiter[] = []

  constructor(private readonly concurrency: number = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('큐 동시성은 1 이상이어야 합니다.')
    }
  }

  async add<T>(task: Task<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw createAbortError()
    await this.acquire(signal)
    if (signal?.aborted) {
      this.release()
      throw createAbortError()
    }

    try {
      return await task(signal)
    } finally {
      this.release()
    }
  }

  get size(): number {
    return this.waiting.length
  }

  get pending(): number {
    return this.running
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++
      return
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiting.indexOf(waiter)
          if (index >= 0) this.waiting.splice(index, 1)
          reject(createAbortError())
        },
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiting.push(waiter)
    })
    this.running++
  }

  private release(): void {
    this.running--
    const next = this.waiting.shift()
    if (!next) return
    next.signal?.removeEventListener('abort', next.onAbort)
    next.resolve()
  }
}

export const thumbnailQueue = new ConcurrencyQueue(2)
