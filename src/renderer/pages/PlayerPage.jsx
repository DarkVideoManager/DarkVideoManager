// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import VideoPlayer from '../components/player/VideoPlayer'
import DetailPanel from '../components/library/DetailPanel'
function PlayerPage() {
  const { libraryId, videoId } = useParams()
  const navigate = useNavigate()
  const [isMaximized, setIsMaximized] = React.useState(false)
  const [pendingSeekRequest, setPendingSeekRequest] = React.useState(null)
  const [nativeLaunchPending, setNativeLaunchPending] = React.useState(false)
  const [subtitleNavigationTarget, setSubtitleNavigationTarget] = React.useState(null)
  const fullscreenExitAt = React.useRef(-Infinity)
  const handleFullscreenChange = React.useCallback((active, explicit) => {
    fullscreenExitAt.current = !active && !explicit ? performance.now() : -Infinity
  }, [])
  const { data: video, isLoading } = useQuery({
    queryKey: ['video', libraryId, videoId],
    queryFn: async () => {
      if (!libraryId || !videoId) return null
      const res = await window.api.videos.get(libraryId, videoId)
      return res.ok ? res.value : null
    },
    enabled: !!libraryId && !!videoId,
  })
  React.useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape' && !nativeLaunchPending) {
        if (
          event.defaultPrevented ||
          document.fullscreenElement ||
          performance.now() - fullscreenExitAt.current < 250
        )
          return
        navigate(-1)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [navigate, nativeLaunchPending])
  React.useEffect(() => {
    return window.api.on.nativePlayerEscape(({ videoId: escapedVideoId }) => {
      if (escapedVideoId !== videoId) return
      navigate(-1)
    })
  }, [navigate, videoId])
  if (isLoading) {
    return (
      <div className={'flex h-screen items-center justify-center bg-zinc-950 text-zinc-400'}>
        {'플레이어를 불러오는 중...'}
      </div>
    )
  }
  if (!video || !libraryId) {
    return (
      <div
        className={
          'flex h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-400'
        }
      >
        <p>{'요청한 영상을 찾을 수 없습니다.'}</p>
        <button
          onClick={() => navigate(-1)}
          className={'rounded bg-zinc-800 px-4 py-2 hover:bg-zinc-700'}
        >
          {'돌아가기'}
        </button>
      </div>
    )
  }
  return (
    <div className={'flex h-screen overflow-hidden bg-zinc-950'}>
      <div className={'relative min-h-0 min-w-0 flex-1'}>
        <VideoPlayer
          video={video}
          libraryId={libraryId}
          seekRequest={pendingSeekRequest}
          onNativeLaunchPendingChange={setNativeLaunchPending}
          subtitleNavigationTarget={subtitleNavigationTarget}
          isMaximized={isMaximized}
          onToggleMaximized={() => setIsMaximized((value) => !value)}
          onFullscreenChange={handleFullscreenChange}
        />
      </div>
      {!isMaximized && (
        <aside className={'w-80 shrink-0 border-l border-zinc-800 bg-zinc-900'}>
          <DetailPanel
            video={video}
            libraryId={libraryId}
            onClose={() => navigate(-1)}
            onVideoDeleted={() => navigate(-1)}
            showCloseButton={false}
            initialTab={'highlights'}
            showPlaybackShortcuts={true}
            subtitleNavigationRef={setSubtitleNavigationTarget}
            onJumpToHighlight={(timeSec) =>
              setPendingSeekRequest({
                timeSec,
                nonce: Date.now(),
              })
            }
          />
        </aside>
      )}
    </div>
  )
}
export default PlayerPage
