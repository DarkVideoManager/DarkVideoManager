import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAbRepeatController, repeatRangeError } from './abRepeat'

class RepeatVideo extends EventTarget {
  currentTime = 1
  paused = false
  ended = false
  seeking = false
  readyState = 2
  play = vi.fn(async () => {
    this.paused = false
    this.ended = false
  })
}

function setup() {
  vi.useFakeTimers()
  const media = new RepeatVideo()
  let seeking = false
  const seek = vi.fn((time: number) => {
    seeking = media.seeking = true
    media.currentTime = time
    media.ended = false
  })
  const onError = vi.fn()
  const controller = createAbRepeatController(media, {
    range: { start: 1, end: 2 },
    isSeekPending: () => seeking,
    seek,
    onError,
  })
  return {
    media,
    seek,
    onError,
    controller,
    setSeekPending(value: boolean) {
      seeking = value
    },
    settle() {
      seeking = media.seeking = false
      media.dispatchEvent(new Event('seeked'))
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('A–B range validation', () => {
  it('requires both points, a minimum interval, and a finite media duration', () => {
    expect(repeatRangeError(null, 2, 10)).toContain('A 시작점과 B 끝점')
    for (const [start, end] of [
      [2, 1],
      [2, 2],
      [2, 2.09],
      [-1, 2],
      [NaN, 2],
      [0, Infinity],
    ]) {
      expect(repeatRangeError(start, end, 10)).toContain('최소 0.1초')
    }
    expect(repeatRangeError(0.3, 0.4, 10)).toBeNull()
    expect(repeatRangeError(0, 10, 10)).toBeNull()
    expect(repeatRangeError(0, 11, 10)).toContain('영상 길이')
    expect(repeatRangeError(0, 1, NaN)).toContain('영상 길이')
  })
})

describe('A–B media clock controller', () => {
  it('loops at B, coalesces a slow seek and repeats again after the seek settles', () => {
    const state = setup()
    state.media.currentTime = 1.99
    state.media.dispatchEvent(new Event('timeupdate'))
    expect(state.seek).not.toHaveBeenCalled()
    state.media.currentTime = 2
    state.media.dispatchEvent(new Event('timeupdate'))
    state.media.dispatchEvent(new Event('timeupdate'))
    vi.advanceTimersByTime(200)
    expect(state.seek).toHaveBeenCalledTimes(1)
    expect(state.seek).toHaveBeenLastCalledWith(1)
    state.settle()
    state.media.currentTime = 2.04
    state.media.dispatchEvent(new Event('timeupdate'))
    expect(state.seek).toHaveBeenCalledTimes(2)
    state.controller.dispose()
  })

  it('uses actual media time at low speed and catches short ranges between timeupdate events', () => {
    const state = setup()
    vi.advanceTimersByTime(1000)
    expect(state.seek).not.toHaveBeenCalled()
    state.media.currentTime = 2.01
    vi.advanceTimersByTime(25)
    expect(state.seek).toHaveBeenCalledOnce()
    state.controller.dispose()
  })

  it('lets a paused or dragged position settle and restores the range when playback resumes', () => {
    const state = setup()
    state.media.paused = true
    state.media.currentTime = 3
    state.media.dispatchEvent(new Event('seeked'))
    vi.advanceTimersByTime(100)
    expect(state.seek).not.toHaveBeenCalled()
    state.media.paused = false
    state.setSeekPending(true)
    state.media.dispatchEvent(new Event('play'))
    expect(state.seek).not.toHaveBeenCalled()
    state.settle()
    expect(state.seek).toHaveBeenCalledWith(1)
    state.controller.dispose()
  })

  it('restarts from A when B is the actual end of the media', () => {
    const state = setup()
    state.media.currentTime = 2
    state.media.paused = state.media.ended = true
    state.media.dispatchEvent(new Event('ended'))
    expect(state.seek).toHaveBeenCalledWith(1)
    expect(state.media.play).toHaveBeenCalledOnce()
    state.controller.dispose()
  })

  it('returns to A after a running seek before A and preserves an in-range seek', () => {
    const state = setup()
    state.media.currentTime = 1.5
    state.media.dispatchEvent(new Event('seeked'))
    expect(state.seek).not.toHaveBeenCalled()
    state.media.currentTime = 0.5
    state.media.dispatchEvent(new Event('seeked'))
    expect(state.seek).toHaveBeenCalledWith(1)
    state.controller.dispose()
  })

  it('reports a failed decoder request and removes listeners/timers on dispose', () => {
    const state = setup()
    const failure = new Error('decoder stopped')
    state.seek.mockImplementationOnce(() => {
      throw failure
    })
    state.media.currentTime = 2
    state.media.dispatchEvent(new Event('timeupdate'))
    expect(state.onError).toHaveBeenCalledWith(failure)
    state.controller.dispose()
    state.media.dispatchEvent(new Event('timeupdate'))
    state.media.dispatchEvent(new Event('seeked'))
    vi.advanceTimersByTime(1000)
    expect(state.seek).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
