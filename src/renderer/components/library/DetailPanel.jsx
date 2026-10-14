// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { thumbnailsApi } from '../../api'
import { toLocalMediaUrl } from '../../utils/media'
import SubtitleGenerationPanel from './SubtitleGenerationPanel'
const STAR_COUNT = 5
function StarRating({ value, onChange }) {
  const [hovered, setHovered] = React.useState(0)
  const displayValue = hovered || value
  return (
    <div
      className={'relative inline-flex'}
      onMouseLeave={() => setHovered(0)}
      role={'slider'}
      aria-label={'??'}
      aria-valuemin={0}
      aria-valuemax={5}
      aria-valuenow={displayValue}
    >
      <div className={'flex gap-0.5'}>
        {Array.from(
          {
            length: STAR_COUNT,
          },
          (_, index) => {
            const star = index + 1
            return (
              <div className={'relative text-xl leading-none'} key={star}>
                <span className={'text-zinc-600'}>{'★'}</span>
                {displayValue >= star && (
                  <span className={'absolute inset-0 text-yellow-400'}>{'★'}</span>
                )}
                {displayValue < star && displayValue >= star - 0.5 && (
                  <span
                    className={'absolute inset-y-0 left-0 overflow-hidden text-yellow-400'}
                    style={{
                      width: '50%',
                    }}
                  >
                    {'★'}
                  </span>
                )}
              </div>
            )
          },
        )}
      </div>
      <div className={'absolute inset-0 grid grid-cols-10'}>
        {Array.from(
          {
            length: STAR_COUNT * 2,
          },
          (_, index) => {
            const nextValue = (index + 1) * 0.5
            return (
              <button
                type={'button'}
                aria-label={`${nextValue}?`}
                className={'h-full w-full'}
                onClick={() => onChange(nextValue)}
                onMouseEnter={() => setHovered(nextValue)}
                key={nextValue}
              />
            )
          },
        )}
      </div>
    </div>
  )
}
function DetailPanel({
  video,
  libraryId,
  onClose,
  showCloseButton = true,
  onJumpToHighlight,
  onVideoDeleted,
  onVideoRestored,
  initialTab = 'info',
  showPlaybackShortcuts = false,
  subtitleNavigationRef,
}) {
  const [tab, setTab] = React.useState(initialTab)
  const [memo2, setMemo] = React.useState(video.memo ?? '')
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false)
  const [deleteMode, setDeleteMode] = React.useState('trash')
  const [deleteError, setDeleteError] = React.useState(null)
  const [restoreError, setRestoreError] = React.useState(null)
  const [actionError, setActionError] = React.useState(null)
  const isRemoved = Boolean(video.removalMode)
  const memoTimerRef = React.useRef(null)
  const qc2 = useQueryClient()
  const { data: highlights = [] } = useQuery({
    queryKey: ['highlights', libraryId, video.id],
    queryFn: async () => {
      const res = await window.api.highlights.list(libraryId, video.id)
      return res.ok ? res.value : []
    },
    enabled: tab === 'highlights',
  })
  const { data: thumbnails = [] } = useQuery({
    queryKey: ['thumbnails', libraryId, video.id],
    queryFn: async () => {
      const res = await thumbnailsApi.getForVideo(libraryId, video.id)
      return res.ok ? res.value : []
    },
  })
  React.useEffect(() => {
    if (isRemoved) return
    if (tab !== 'highlights') return
    if (highlights.length === 0) return
    let active = true
    const recoverMissingThumbnails = async () => {
      let repaired = false
      for (const highlight of highlights) {
        if (!active) return
        if (findThumbnailForTime(thumbnails, highlight.timeStart)) continue
        const res = await thumbnailsApi.captureAtTime(
          libraryId,
          video.id,
          highlight.timeStart,
          false,
        )
        if (!active) return
        if (res.ok) {
          if (Math.abs(res.value.timeSec - highlight.timeStart) > 0.05) {
            const updateRes = await window.api.highlights.update(libraryId, highlight.id, {
              timeStart: res.value.timeSec,
            })
            if (!updateRes.ok) {
              throw new Error(updateRes.error)
            }
          }
          repaired = true
        }
      }
      if (repaired) {
        qc2.invalidateQueries({
          queryKey: ['thumbnails', libraryId, video.id],
        })
        qc2.invalidateQueries({
          queryKey: ['video', libraryId, video.id],
        })
        qc2.invalidateQueries({
          queryKey: ['videos', libraryId],
        })
      }
    }
    // Recovery is best effort: busy libraries can reject it while another task owns the database.
    void recoverMissingThumbnails().catch(() => undefined)
    return () => {
      active = false
    }
  }, [highlights, isRemoved, libraryId, qc2, tab, thumbnails, video.id])
  const updateMeta = useMutation({
    onMutate: () => setActionError(null),
    mutationFn: async (patch) => {
      const res = await window.api.videos.updateMeta(libraryId, video.id, {
        rating: patch.rating ?? video.rating,
        memo: patch.memo ?? video.memo ?? '',
      })
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => {
      qc2.invalidateQueries({
        queryKey: ['video', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
    },
    onError: (error) =>
      setActionError(
        `메타데이터를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  const deleteHighlight = useMutation({
    onMutate: () => setActionError(null),
    mutationFn: async (id2) => {
      const res = await window.api.highlights.delete(libraryId, id2)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () =>
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      }),
    onError: (error) =>
      setActionError(
        `하이라이트를 삭제하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  const deleteVideo = useMutation({
    mutationFn: async (mode) => {
      const res = await window.api.videos.delete(libraryId, video.id, mode)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => {
      qc2.removeQueries({
        queryKey: ['video', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['subtitles', libraryId, video.id],
      })
      qc2.invalidateQueries({ queryKey: ['stats', libraryId] })
      setShowDeleteConfirm(false)
      onVideoDeleted?.()
    },
    onError: (error) => {
      setDeleteError(error instanceof Error ? error.message : '항목을 제거하지 못했습니다')
    },
  })
  const restoreVideo = useMutation({
    mutationFn: async () => {
      const res = await window.api.videos.restore(libraryId, video.id)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => {
      qc2.invalidateQueries({ queryKey: ['video', libraryId, video.id] })
      qc2.invalidateQueries({ queryKey: ['videos', libraryId] })
      qc2.invalidateQueries({ queryKey: ['stats', libraryId] })
      setRestoreError(null)
      onVideoRestored?.()
    },
    onError: (error) => {
      setRestoreError(error instanceof Error ? error.message : '목록을 복구하지 못했습니다')
    },
  })
  const ensureThumbnail = useMutation({
    onMutate: () => setActionError(null),
    mutationFn: async () => {
      const res = await thumbnailsApi.ensureForVideo(libraryId, video.id, true)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: () => {
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['video', libraryId, video.id],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
    },
    onError: (error) =>
      setActionError(
        `썸네일을 생성하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
  React.useEffect(() => {
    setMemo(video.memo ?? '')
  }, [video.memo])
  React.useEffect(() => {
    setTab(initialTab)
  }, [initialTab, video.id])
  React.useEffect(() => {
    setShowDeleteConfirm(false)
    setDeleteError(null)
    setRestoreError(null)
    setActionError(null)
  }, [video.id])
  React.useEffect(() => {
    if (!showDeleteConfirm) return
    const cancelOnEscape = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!deleteVideo.isPending) setShowDeleteConfirm(false)
    }
    window.addEventListener('keydown', cancelOnEscape, true)
    return () => window.removeEventListener('keydown', cancelOnEscape, true)
  }, [showDeleteConfirm, deleteVideo.isPending])
  function confirmRemoval(mode) {
    setDeleteMode(mode)
    setDeleteError(null)
    setShowDeleteConfirm(true)
  }
  function handleMemoChange(value) {
    setMemo(value)
    if (memoTimerRef.current) clearTimeout(memoTimerRef.current)
    memoTimerRef.current = setTimeout(() => {
      updateMeta.mutate({
        memo: value,
      })
    }, 500)
  }
  const durationStr =
    video.durationSec != null
      ? `${Math.floor(video.durationSec / 60)}분 ${Math.floor(video.durationSec % 60)}초`
      : '정보 없음'
  const fileSizeMb = video.sizeBytes
    ? `${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB`
    : '정보 없음'
  const primaryThumbnail = thumbnails.find((thumbnail) => thumbnail.isPrimary) ?? thumbnails[0]
  const hasThumbnail = thumbnails.length > 0
  const displayTitle = video.title?.trim() || video.fileName
  return (
    <div className={'relative flex h-full flex-col bg-zinc-900 text-sm text-zinc-100'}>
      <div className={'flex items-center justify-between border-b border-zinc-800 px-4 py-3'}>
        <div className={'min-w-0'}>
          <p className={'truncate font-semibold'} title={displayTitle}>
            {displayTitle}
          </p>
          {video.title?.trim() && (
            <p className={'truncate text-xs text-zinc-500'} title={video.fileName}>
              {video.fileName}
            </p>
          )}
        </div>
        {showCloseButton ? (
          <button onClick={onClose} className={'text-zinc-500 hover:text-white'}>
            {'닫기'}
          </button>
        ) : (
          <span className={'whitespace-nowrap text-xs tracking-wide text-zinc-600'}>
            {'상세 정보'}
          </span>
        )}
      </div>
      {actionError && (
        <p
          role="alert"
          className="shrink-0 break-words border-b border-red-900 bg-red-950/40 px-4 py-3 text-xs text-red-300"
        >
          {actionError}
        </p>
      )}
      {isRemoved && (
        <div className="border-b border-zinc-700 bg-zinc-950/60 px-4 py-3">
          <p className="text-sm font-medium text-amber-200">제거한 항목</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-300">
            {video.removalMode === 'trash'
              ? 'Windows 휴지통에서 원본 파일을 먼저 복원한 다음 목록 복구를 눌러주세요.'
              : '원본 파일은 그대로 있습니다. 목록 복구를 누르면 다시 표시됩니다.'}
          </p>
          <p className="mt-1 text-xs text-zinc-400">별점, 메모, 하이라이트는 보관되어 있습니다.</p>
          <p className="mt-2 break-all font-mono text-[11px] text-zinc-400">{video.filePath}</p>
          {restoreError && (
            <p role="alert" className="mt-2 text-xs text-red-300">
              {restoreError}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setRestoreError(null)
              restoreVideo.mutate()
            }}
            disabled={restoreVideo.isPending}
            className="mt-3 w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {restoreVideo.isPending ? '복구 중...' : '목록 복구'}
          </button>
        </div>
      )}
      <div className={'flex border-b border-zinc-800'}>
        {(subtitleNavigationRef ? ['info', 'highlights', 'subtitles'] : ['info', 'highlights']).map(
          (value) => (
            <button
              onClick={() => setTab(value)}
              className={`flex-1 whitespace-nowrap px-3 py-2 text-xs font-medium ${tab === value ? 'border-b-2 border-indigo-400 text-indigo-400' : 'text-zinc-500'}`}
              key={value}
            >
              {value === 'info' ? '정보' : value === 'highlights' ? '하이라이트' : '자막 탐색'}
            </button>
          ),
        )}
      </div>
      <div
        className={
          tab === 'subtitles' ? 'min-h-0 flex-1 overflow-hidden' : 'flex-1 overflow-y-auto p-4'
        }
      >
        {tab === 'subtitles' ? (
          <div ref={subtitleNavigationRef} className="h-full min-h-0" />
        ) : tab === 'info' ? (
          <div className={'space-y-4'}>
            {primaryThumbnail ? (
              <img
                src={toLocalMediaUrl(primaryThumbnail.filePath, primaryThumbnail.id)}
                alt={'썸네일'}
                className={'w-full rounded object-cover'}
              />
            ) : (
              <div
                className={
                  'flex aspect-video items-center justify-center rounded bg-zinc-800 text-xs text-zinc-500'
                }
              >
                {'썸네일이 없습니다'}
              </div>
            )}
            <div
              className={
                'flex items-center justify-between rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2'
              }
            >
              <div>
                <p className={'text-xs text-zinc-500'}>{'썸네일 상태'}</p>
                <p className={`text-xs ${hasThumbnail ? 'text-green-400' : 'text-amber-400'}`}>
                  {hasThumbnail
                    ? `${thumbnails.length}개 썸네일 사용 가능`
                    : '아직 썸네일이 없습니다'}
                </p>
              </div>
              <button
                onClick={() => ensureThumbnail.mutate()}
                disabled={isRemoved || ensureThumbnail.isPending}
                className={
                  'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40'
                }
              >
                {ensureThumbnail.isPending ? '작업 중...' : '다시 생성'}
              </button>
            </div>
            <SubtitleGenerationPanel
              key={`${libraryId}:${video.id}`}
              libraryId={libraryId}
              videoId={video.id}
              disabled={isRemoved}
            />
            <div className={'space-y-1 text-xs text-zinc-400'}>
              {video.title?.trim() && (
                <p>
                  <span className={'text-zinc-500'}>{'제목:'}</span> {video.title}
                </p>
              )}
              <p>
                <span className={'text-zinc-500'}>{'길이:'}</span> {durationStr}
              </p>
              {video.width != null && video.height != null && (
                <p>
                  <span className={'text-zinc-500'}>{'해상도:'}</span> {video.width}
                  {'x'}
                  {video.height}
                </p>
              )}
              {video.codec && (
                <p>
                  <span className={'text-zinc-500'}>{'코덱:'}</span> {video.codec}
                </p>
              )}
              <p>
                <span className={'text-zinc-500'}>{'크기:'}</span> {fileSizeMb}
              </p>
              <p>
                <span className={'text-zinc-500'}>{'재생 횟수:'}</span>{' '}
                {video.playCount.toLocaleString()}
              </p>
              <p>
                <span className={'text-zinc-500'}>{'누적 재생 시간:'}</span>{' '}
                {formatDuration$1(video.playTimeSec)}
              </p>
              <p>
                <span className={'text-zinc-500'}>{'마지막 재생:'}</span>{' '}
                {formatDateTime$1(video.lastPlayedAt)}
              </p>
              <p>
                <span className={'text-zinc-500'}>{'태그:'}</span> {video.tags || '없음'}
              </p>
            </div>
            <div>
              <p className={'mb-1 text-xs text-zinc-500'}>{'별점'}</p>
              <StarRating
                value={video.rating ?? 0}
                onChange={(value) =>
                  updateMeta.mutate({
                    rating: value,
                  })
                }
              />
            </div>
            <div>
              <p className={'mb-1 text-xs text-zinc-500'}>{'메모'}</p>
              <textarea
                value={memo2}
                onChange={(event) => handleMemoChange(event.target.value)}
                rows={5}
                className={
                  'w-full resize-none rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-hidden focus:ring-1 focus:ring-indigo-500'
                }
                placeholder={'이 영상에 대한 메모를 적어보세요...'}
              />
            </div>
            {showPlaybackShortcuts && (
              <div className={'rounded border border-zinc-800 bg-zinc-950/40 px-3 py-2'}>
                <p className={'mb-2 text-xs text-zinc-500'}>{'재생 단축키'}</p>
                <div className={'space-y-1 text-xs text-zinc-300'}>
                  <p>{'Space/P: 일시정지'}</p>
                  <p>{'A/D 또는 좌우: 이동'}</p>
                  <p>{'Z/C: 이전/다음 자막'}</p>
                  <p>{'Q/E: 이전/다음 하이라이트'}</p>
                  <p>{'S: 현재 하이라이트 저장'}</p>
                  <p>{'F: 썸네일 지정'}</p>
                  <p>{'H: 하이라이트 추가'}</p>
                  <p>{'O: 외부 플레이어'}</p>
                </div>
              </div>
            )}
            {!isRemoved && (
              <div className={'space-y-2 border-t border-zinc-800 pt-4'}>
                <button
                  type={'button'}
                  onClick={() => confirmRemoval('trash')}
                  className={
                    'w-full rounded border border-red-950 bg-red-950/40 px-3 py-2 text-xs font-medium text-red-200 hover:bg-red-950/70'
                  }
                >
                  {'휴지통으로 이동'}
                </button>
                <button
                  type="button"
                  onClick={() => confirmRemoval('remove')}
                  className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
                >
                  목록에서만 제거
                </button>
              </div>
            )}
          </div>
        ) : highlights.length === 0 ? (
          <p className={'text-xs text-zinc-500'}>
            {'아직 하이라이트가 없습니다. 재생 중 H 키로 추가할 수 있습니다.'}
          </p>
        ) : (
          <div className={'grid grid-cols-1 gap-3'}>
            {highlights.map((highlight) => (
              <HighlightThumbnailCard
                highlight={highlight}
                thumbnail={findThumbnailForTime(thumbnails, highlight.timeStart)}
                onJump={isRemoved ? undefined : onJumpToHighlight}
                onDelete={(id2) => deleteHighlight.mutate(id2)}
                key={highlight.id}
              />
            ))}
          </div>
        )}
      </div>
      {showDeleteConfirm && (
        <div className={'absolute inset-0 z-30 flex items-center bg-black/75 p-4'}>
          <div
            className={
              'max-h-full w-full overflow-y-auto rounded border border-red-900 bg-zinc-950 p-4 shadow-2xl'
            }
            role={'dialog'}
            aria-modal={'true'}
            aria-labelledby={'delete-video-title'}
          >
            <h2 id={'delete-video-title'} className={'text-sm font-semibold text-red-200'}>
              {deleteMode === 'trash' ? '휴지통으로 이동할까요?' : '목록에서만 제거할까요?'}
            </h2>
            <p className={'mt-2 text-xs leading-relaxed text-zinc-300'}>
              {deleteMode === 'trash'
                ? '원본 파일을 Windows 휴지통으로 이동하고 목록에서 숨깁니다. 별점, 메모, 하이라이트는 보관됩니다.'
                : '원본 파일은 그대로 두고 목록에서만 숨깁니다. 별점, 메모, 하이라이트는 보관되며 다시 스캔해도 자동으로 표시되지 않습니다.'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              {deleteMode === 'trash'
                ? '다시 보려면 Windows 휴지통에서 원본을 복원한 뒤 제거한 항목에서 목록 복구를 눌러주세요.'
                : '제거한 항목에서 목록 복구를 눌러 되돌릴 수 있습니다.'}
            </p>
            <div className={'mt-3 rounded border border-zinc-800 bg-black/40 p-3'}>
              <p className={'truncate text-xs font-medium text-zinc-100'} title={video.fileName}>
                {video.fileName}
              </p>
              <p className={'mt-1 break-all font-mono text-[11px] leading-relaxed text-zinc-400'}>
                {video.filePath}
              </p>
            </div>
            {deleteError && (
              <p role="alert" className={'mt-3 text-xs text-red-300'}>
                {deleteError}
              </p>
            )}
            <div className={'mt-4 flex justify-end gap-2'}>
              <button
                type={'button'}
                autoFocus
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleteVideo.isPending}
                className={
                  'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50'
                }
              >
                {'취소'}
              </button>
              <button
                type={'button'}
                onClick={() => deleteVideo.mutate(deleteMode)}
                disabled={deleteVideo.isPending}
                className={
                  'rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50'
                }
              >
                {deleteVideo.isPending
                  ? '처리 중...'
                  : deleteMode === 'trash'
                    ? '휴지통으로 이동'
                    : '목록에서만 제거'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
function HighlightThumbnailCard({ highlight, thumbnail, onJump, onDelete }) {
  return (
    <div className={'overflow-hidden rounded-lg border border-zinc-800 bg-zinc-800/80'}>
      <button
        onClick={() => onJump?.(highlight.timeStart)}
        disabled={!onJump}
        className={'block w-full text-left disabled:cursor-default'}
      >
        {thumbnail ? (
          <img
            src={toLocalMediaUrl(thumbnail.filePath, `${highlight.id}-${thumbnail.timeSec}`)}
            alt={`하이라이트 ${formatTime$1(highlight.timeStart)}`}
            className={'aspect-video w-full object-cover'}
          />
        ) : (
          <div
            className={
              'flex aspect-video items-center justify-center bg-zinc-900 text-xs text-zinc-500'
            }
          >
            {'연결된 썸네일이 없습니다'}
          </div>
        )}
        <div className={'flex items-center gap-2 px-3 py-2'}>
          <span
            className={'h-2.5 w-2.5 shrink-0 rounded-full'}
            style={{
              backgroundColor: colorToHex$1(highlight.color),
            }}
          />
          <span className={'flex-1 text-xs text-zinc-200 hover:text-white'}>
            {formatTime$1(highlight.timeStart)}
            {highlight.label && (
              <span className={'ml-1 text-zinc-500'}>
                {'- '}
                {highlight.label}
              </span>
            )}
          </span>
        </div>
      </button>
      <div className={'border-t border-zinc-700 px-3 py-2'}>
        <button
          onClick={() => onDelete(highlight.id)}
          className={'text-xs text-zinc-500 hover:text-red-400'}
        >
          {'삭제'}
        </button>
      </div>
    </div>
  )
}
function colorToHex$1(color2) {
  const map2 = {
    yellow: '#facc15',
    red: '#ef4444',
    blue: '#3b82f6',
    green: '#22c55e',
    purple: '#a855f7',
  }
  return map2[color2] ?? '#facc15'
}
function formatTime$1(sec) {
  const minutes = Math.floor(sec / 60)
  const seconds = Math.floor(sec % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
function formatDuration$1(sec) {
  const hours = Math.floor(sec / 3600)
  const minutes = Math.floor((sec % 3600) / 60)
  const seconds = Math.floor(sec % 60)
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
function formatDateTime$1(value) {
  if (!value) return '없음'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}
function findThumbnailForTime(thumbnails, timeSec) {
  let closest
  let closestDistance = Number.POSITIVE_INFINITY
  for (const thumbnail of thumbnails) {
    const distance = Math.abs(thumbnail.timeSec - timeSec)
    if (distance < closestDistance) {
      closest = thumbnail
      closestDistance = distance
    }
  }
  if (closestDistance <= 2.1) {
    return closest
  }
  return void 0
}
export default DetailPanel
