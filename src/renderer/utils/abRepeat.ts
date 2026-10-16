export interface RepeatRange {
  start: number
  end: number
}

export function repeatRangeError(
  start: number | null,
  end: number | null,
  duration: number,
): string | null {
  if (start === null || end === null) return '현재 위치에서 A 시작점과 B 끝점을 설정하세요.'
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 0.1 - 1e-6)
    return 'B 끝점은 A 시작점보다 최소 0.1초 뒤여야 합니다.'
  if (!Number.isFinite(duration) || duration <= 0 || end > duration + 0.001)
    return '영상 길이 안에서 반복 구간을 설정하세요.'
  return null
}

type RepeatMedia = Pick<
  HTMLVideoElement,
  | 'currentTime'
  | 'paused'
  | 'ended'
  | 'seeking'
  | 'readyState'
  | 'play'
  | 'addEventListener'
  | 'removeEventListener'
>

/** Use media time, rather than wall time, so low speeds and pauses retain the same A–B range. */
export function createAbRepeatController(
  media: RepeatMedia,
  options: {
    range: RepeatRange
    isSeekPending(): boolean
    seek(time: number): void
    onError(error: unknown): void
  },
) {
  let disposed = false
  let pending = false

  function check(): void {
    if (
      disposed ||
      pending ||
      media.readyState < 1 ||
      media.seeking ||
      options.isSeekPending() ||
      (media.paused && !media.ended)
    )
      return
    if (media.currentTime >= options.range.start && media.currentTime < options.range.end) return
    // Mark before requesting: a fast decoder can settle synchronously.
    pending = true
    const restartEndedPlayback = media.ended
    try {
      options.seek(options.range.start)
      if (!media.seeking && !options.isSeekPending()) pending = false
      if (restartEndedPlayback) void media.play().catch(options.onError)
    } catch (error) {
      pending = false
      options.onError(error)
    }
  }

  function settled(): void {
    pending = false
    check()
  }

  const events = ['timeupdate', 'play', 'ended'] as const
  for (const event of events) media.addEventListener(event, check)
  media.addEventListener('seeked', settled)
  // timeupdate alone can be as sparse as four events per second. Checking the actual
  // media clock also supports short ranges without rounding to displayed seconds.
  const timer = setInterval(check, 25)
  check()
  return {
    dispose(): void {
      disposed = true
      clearInterval(timer)
      for (const event of events) media.removeEventListener(event, check)
      media.removeEventListener('seeked', settled)
    },
  }
}
