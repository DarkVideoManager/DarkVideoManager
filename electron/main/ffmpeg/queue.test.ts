import { describe, expect, it } from 'vitest'

import { ConcurrencyQueue } from './queue'

describe('ConcurrencyQueue', () => {
  it('enforces the concurrency limit and removes canceled waiters', async () => {
    const queue = new ConcurrencyQueue(2)
    let active = 0
    let maximumActive = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const task = async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await held
      active--
      return active
    }

    const first = queue.add(task)
    const second = queue.add(task)
    await Promise.resolve()
    await Promise.resolve()

    const controller = new AbortController()
    const canceled = queue.add(task, controller.signal)
    expect(queue.pending).toBe(2)
    expect(queue.size).toBe(1)

    controller.abort()
    await expect(canceled).rejects.toThrow('작업이 취소되었습니다.')
    expect(queue.size).toBe(0)

    release()
    await Promise.all([first, second])
    expect(maximumActive).toBe(2)
    expect(queue.pending).toBe(0)
  })
})
