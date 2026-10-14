import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSeekController } from './seekController'

class SlowVideo extends EventTarget {
  duration = 300
  readyState = 1
  seeking = false
  position = 10
  writes: number[] = []
  interruptions = 0
  get currentTime(): number {
    return this.position
  }
  set currentTime(time: number) {
    if (this.seeking) this.interruptions++
    this.position = time
    this.writes.push(time)
    this.seeking = true
  }
  complete(): void {
    this.seeking = false
    this.dispatchEvent(new Event('seeked'))
  }
}

function setup(video = new SlowVideo()) {
  const options = {
    onStart: vi.fn(),
    onTarget: vi.fn(),
    onSettled: vi.fn(),
    onError: vi.fn(),
    fallbackDuration: 300,
  }
  const controller = createSeekController(video, options)
  return { video, controller, ...options }
}

afterEach(() => vi.useRealTimers())

describe('decoder-aware seeking', () => {
  it('coalesces a slow decoder backlog, preserves direction changes and finishes at the latest target', () => {
    const { video, controller, onSettled, onStart } = setup()
    controller.request(11)
    for (let time = 12; time <= 80; time++) controller.request(time, true)
    controller.request(35, true)
    controller.finish()
    expect(video.writes).toEqual([11])
    expect(controller.position).toBe(35)
    expect(onSettled).not.toHaveBeenCalled()
    video.complete()
    expect(video.writes).toEqual([11, 35])
    video.complete()
    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(35)
    expect(controller.isActive).toBe(false)
    expect(video.interruptions).toBe(0)
    expect(onStart).toHaveBeenCalledOnce()
    expect(onStart).toHaveBeenCalledWith(10)
  })

  it('limits fast-decoder previews without delaying the exact release target', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    const { video, controller } = setup()
    controller.request(20, true)
    video.complete()
    vi.advanceTimersByTime(60)
    controller.request(25, true)
    expect(video.writes).toEqual([20])
    vi.advanceTimersByTime(40)
    expect(video.writes).toEqual([20, 25])
    video.complete()
    controller.request(30, true)
    controller.finish()
    expect(video.writes).toEqual([20, 25, 30])
    video.complete()
    vi.runAllTimers()
    expect(video.writes).toEqual([20, 25, 30])
  })

  it('waits for metadata and clamps the pending target to the actual duration', () => {
    const { video, controller, onSettled } = setup()
    video.readyState = 0
    video.duration = NaN
    controller.request(80, true)
    controller.finish()
    expect(video.writes).toEqual([])
    video.duration = 50
    video.readyState = 1
    video.dispatchEvent(new Event('loadedmetadata'))
    expect(video.writes).toEqual([50])
    video.complete()
    expect(onSettled).toHaveBeenCalledWith(50)
  })

  it('does not restart decoder work at the start or end boundary', () => {
    const { video, controller, onSettled } = setup()
    controller.request(-100)
    video.complete()
    controller.request(-1)
    controller.request(1000)
    video.complete()
    controller.request(999)
    expect(video.writes).toEqual([0, 300])
    expect(controller.isActive).toBe(false)
    expect(onSettled).toHaveBeenLastCalledWith(300)
  })

  it('corrects a keyframe preview with one exact seek on release', () => {
    const video = Object.assign(new SlowVideo(), {
      fastSeek: vi.fn(function (this: SlowVideo, time: number) {
        this.currentTime = Math.floor(time / 10) * 10
      }),
    })
    const { controller, onSettled } = setup(video)
    controller.request(27, true)
    controller.finish()
    expect(video.writes).toEqual([20])
    video.complete()
    expect(video.writes).toEqual([20, 27])
    video.complete()
    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(27)
    expect(video.fastSeek).toHaveBeenCalledOnce()
  })

  it('does not let a disposed view seek or save after decoder completion', () => {
    const { video, controller, onSettled } = setup()
    controller.request(11)
    controller.request(80, true)
    controller.dispose()
    video.complete()
    controller.finish()
    controller.request(90)
    expect(video.writes).toEqual([11])
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('removes scheduled previews on cancel, source reset or decoding failure', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    for (const action of ['cancel', 'emptied', 'error']) {
      const { video, controller, onSettled } = setup()
      controller.request(20, true)
      video.complete()
      controller.request(30, true)
      if (action === 'cancel') controller.cancel()
      else video.dispatchEvent(new Event(action))
      vi.runAllTimers()
      expect(video.writes).toEqual([20])
      expect(controller.isActive).toBe(false)
      expect(onSettled).not.toHaveBeenCalled()
      controller.dispose()
    }
  })

  it('contains seek failures and allows a subsequent request', () => {
    const video = Object.assign(new SlowVideo(), {
      fastSeek: vi.fn(() => {
        throw new Error('decoder unavailable')
      }),
    })
    const { controller, onError, onSettled } = setup(video)
    controller.request(20, true)
    expect(onError).toHaveBeenCalledOnce()
    expect(controller.isActive).toBe(false)
    controller.request(22)
    video.complete()
    expect(onSettled).toHaveBeenCalledWith(22)
  })
})
