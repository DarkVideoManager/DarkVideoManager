import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

const EXIT_EVENT = 'darkvm:private-exit'
export function requestPrivacyExit() {
  window.dispatchEvent(new Event(EXIT_EVENT))
}
export function usePrivacySettings() {
  return useQuery({
    queryKey: ['privacy-settings'],
    queryFn: async () => {
      const result = await window.api.privacy.get()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: Infinity,
    retry: false,
  })
}

export default function PrivacyBoundary({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  useEffect(() => {
    const hide = () => {
      if (busy.current) return
      busy.current = true
      // Remove visible media before waiting for native playback or browser launch.
      document.querySelectorAll('video, audio').forEach((node) => {
        const media = node as HTMLMediaElement
        media.pause()
        media.style.visibility = 'hidden'
      })
      setHidden(true)
      setError(null)
      setPending(true)
      void (async () => {
        try {
          const leavingFullscreen = document.fullscreenElement
            ? document.exitFullscreen().catch(() => undefined)
            : Promise.resolve()
          const result = await window.api.privacy.exit()
          await leavingFullscreen
          if (!result.ok) throw new Error(result.error)
          if (result.value === 'close') {
            const closed = await window.api.app.quit()
            if (!closed.ok) throw new Error(closed.error)
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          busy.current = false
          setPending(false)
        }
      })()
    }
    const key = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'h'
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) hide()
      }
    }
    window.addEventListener(EXIT_EVENT, hide)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener(EXIT_EVENT, hide)
      window.removeEventListener('keydown', key, true)
    }
  }, [])
  if (!hidden) return children
  return (
    <main className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-200">
      <section aria-label="가림 화면" className="max-w-lg space-y-4 text-center">
        <h1 className="text-lg">화면이 가려졌습니다</h1>
        <p className="text-sm text-zinc-400">앱 화면을 다시 열려면 아래 버튼을 누르세요.</p>
        {pending && <p role="status">재생을 정리하는 중...</p>}
        {error && <p role="alert">{error}</p>}
        <button
          disabled={pending}
          onClick={() => setHidden(false)}
          className="rounded bg-zinc-700 px-4 py-2 disabled:opacity-50"
        >
          화면 다시 열기
        </button>
      </section>
    </main>
  )
}
