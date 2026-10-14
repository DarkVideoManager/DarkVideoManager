type SeekMedia = Pick<
  HTMLVideoElement,
  'currentTime' | 'duration' | 'readyState' | 'seeking' | 'addEventListener' | 'removeEventListener'
> & { fastSeek?: (time: number) => void }

interface SeekOptions {
  fallbackDuration?: number
  onStart?(time: number): void
  onTarget(time: number): void
  onSettled(time: number): void
  onError(error: unknown): void
}

/** Keep one decoder request and one latest target, rather than interrupting every frame. */
export function createSeekController(media: SeekMedia, options: SeekOptions) {
  let target: number | null = null
  let active = false
  let continuous = false
  let pending = false
  let inFlight = false
  let approximate = false
  let disposed = false
  let lastIssuedAt = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined

  function clamp(time: number): number {
    const duration =
      Number.isFinite(media.duration) && media.duration > 0
        ? media.duration
        : options.fallbackDuration
    const value = Number.isFinite(time) ? Math.max(0, time) : 0
    return duration && duration > 0 ? Math.min(value, duration) : value
  }

  function clearTimer(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function cancel(): void {
    clearTimer()
    target = null
    active = continuous = pending = inFlight = approximate = false
  }

  function settle(): void {
    if (disposed || !active || continuous || pending || inFlight || target === null) return
    const settledTarget = target
    cancel()
    options.onSettled(settledTarget)
  }

  function pump(): void {
    clearTimer()
    if (disposed || !active || target === null || inFlight || media.seeking) return
    if (!pending) {
      settle()
      return
    }
    // Preserve the latest request until metadata makes currentTime writable.
    if (media.readyState === 0) return
    target = clamp(target)
    if (Math.abs(media.currentTime - target) < 0.001 && !approximate) {
      pending = false
      settle()
      return
    }
    const remaining = 100 - (performance.now() - lastIssuedAt)
    if (continuous && remaining > 0) {
      timer = setTimeout(pump, remaining)
      return
    }
    pending = false
    inFlight = true
    approximate = continuous && typeof media.fastSeek === 'function'
    lastIssuedAt = performance.now()
    try {
      if (approximate) media.fastSeek!(target)
      else media.currentTime = target
      // A same-position/keyframe seek may not produce a seeked event.
      if (!media.seeking) {
        inFlight = false
        settle()
      }
    } catch (error) {
      cancel()
      options.onError(error)
    }
  }

  function onSeeked(): void {
    if (disposed || !active || media.seeking) return
    inFlight = false
    // Fast previews are approximate; the final position must always use currentTime.
    if (approximate && !continuous) pending = true
    pump()
  }

  function onError(): void {
    // Do not keep a failed source's target alive after the media element reports an error.
    cancel()
  }

  media.addEventListener('seeked', onSeeked)
  media.addEventListener('loadedmetadata', pump)
  media.addEventListener('error', onError)
  media.addEventListener('emptied', cancel)

  return {
    get position(): number {
      return target ?? media.currentTime
    },
    get isActive(): boolean {
      return active
    },
    request(time: number, preview = false): void {
      if (disposed) return
      if (!active) options.onStart?.(media.currentTime)
      target = clamp(time)
      active = pending = true
      continuous = preview
      options.onTarget(target)
      pump()
    },
    finish(): void {
      if (disposed || !active) return
      continuous = false
      if (approximate) pending = true
      pump()
    },
    cancel,
    dispose(): void {
      disposed = true
      cancel()
      media.removeEventListener('seeked', onSeeked)
      media.removeEventListener('loadedmetadata', pump)
      media.removeEventListener('error', onError)
      media.removeEventListener('emptied', cancel)
    },
  }
}
