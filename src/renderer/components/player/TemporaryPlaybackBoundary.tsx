import { useEffect, useRef, useState, type ReactNode } from 'react'

type Media = { token: string; fileName: string; sourceUrl: string }

/** Standalone playback never receives a library/video ID or calls persistence APIs. */
export default function TemporaryPlaybackBoundary({ children }: { children: ReactNode }) {
  const [media, setMedia] = useState<Media | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const current = useRef<Media | null>(null)
  const request = useRef(0)
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const lifecycleRequest = request
    function preventFileNavigation(event: DragEvent) {
      // Also block URL/text drops, so they cannot navigate the Electron window.
      event.preventDefault()
    }
    async function drop(event: DragEvent) {
      event.preventDefault()
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length !== 1) {
        setError('탐색기의 영상 파일을 한 번에 하나씩 놓아 주세요. URL과 폴더는 열 수 없습니다.')
        return
      }
      const id = ++request.current
      setOpening(true)
      setError(null)
      try {
        const result = await window.api.temporaryPlayback.openDroppedFiles(files)
        if (id !== request.current) {
          if (result.ok) void window.api.temporaryPlayback.close(result.value.token)
          return
        }
        if (!result.ok) {
          setError(result.error)
          return
        }
        video.current?.pause()
        current.current = result.value
        setMedia(result.value)
      } catch {
        if (id === request.current) setError('영상을 열지 못했습니다. 파일 위치를 확인해 주세요.')
      } finally {
        if (id === request.current) setOpening(false)
      }
    }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', drop)
    return () => {
      lifecycleRequest.current++
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', drop)
      if (current.current) void window.api.temporaryPlayback.close(current.current.token)
    }
  }, [])

  function close() {
    request.current++
    setOpening(false)
    video.current?.pause()
    if (current.current) void window.api.temporaryPlayback.close(current.current.token)
    current.current = null
    setMedia(null)
    setError(null)
  }

  return (
    <>
      {media ? (
        <main
          className="flex h-screen flex-col bg-zinc-950 text-zinc-200"
          aria-label="임시 영상 재생"
        >
          <header className="flex items-center gap-4 border-b border-zinc-800 p-4">
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-medium">{media.fileName}</h1>
              <p className="text-sm text-zinc-400">
                바로 재생 · 라이브러리와 재생 기록에 저장하지 않습니다.
              </p>
            </div>
            <button className="rounded bg-zinc-800 px-4 py-2 hover:bg-zinc-700" onClick={close}>
              재생 닫기
            </button>
          </header>
          <video
            key={media.token}
            ref={video}
            src={media.sourceUrl}
            controls
            autoPlay
            className="min-h-0 flex-1 bg-black"
            aria-label="드롭한 영상"
            onError={() =>
              setError(
                '이 영상의 코덱은 바로 재생을 지원하지 않거나 파일을 읽을 수 없습니다. 호환되는 MP4·WebM 파일을 사용하거나 라이브러리에 추가해 외부 플레이어로 열어 주세요.',
              )
            }
          />
          <p className="p-3 text-sm text-zinc-400">
            다른 영상 파일 하나를 이 창에 놓으면 교체합니다. 라이브러리에 보관하려면 재생을 닫고
            영상 추가를 선택하세요.
          </p>
        </main>
      ) : (
        children
      )}
      {!media && (
        <p className="pointer-events-none fixed bottom-2 left-1/2 z-40 -translate-x-1/2 rounded bg-zinc-900/95 px-3 py-1 text-xs text-zinc-400">
          탐색기의 영상 파일 하나를 이 창에 놓으면 바로 재생합니다.
        </p>
      )}
      {opening && (
        <p role="status" className="fixed bottom-14 left-4 z-50 rounded bg-zinc-800 p-3 text-white">
          영상을 여는 중...
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="fixed bottom-14 left-4 right-4 z-50 flex items-center gap-3 rounded border border-amber-700 bg-zinc-900 p-3 text-sm text-amber-200"
        >
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)}>안내 닫기</button>
        </div>
      )}
    </>
  )
}
