// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { toLocalMediaUrl } from '../../utils/media'
import ProtectedThumbnail from '../privacy/ProtectedThumbnail'
const SUBTITLE_PHASE_LABELS = {
  queued: '자막 생성 대기',
  preparing: '자막 생성 준비 중',
  loading: '음성 모델 로딩 중',
  transcribing: '자막 생성 중',
  translating: '한국어 번역 중',
  saving: '자막 저장 중',
  pausing: '자막 일시정지 중',
  paused: '자막 일시정지',
  removing: '자막 작업 삭제 중',
  failed: '자막 생성 실패',
}
const RUNNING_SUBTITLE_PHASES = new Set([
  'preparing',
  'loading',
  'transcribing',
  'translating',
  'saving',
  'pausing',
  'removing',
])
function VideoCard({ video, subtitleJob, isSelected, onClick, onDoubleClick }) {
  const primary = video.primaryThumbnailPath
  const hasThumbnail = Boolean(primary)
  const hasSubtitles = Boolean(video.hasSubtitles)
  const displayTitle = video.title?.trim() || video.fileName
  const subtitleLabel = SUBTITLE_PHASE_LABELS[subtitleJob?.phase]
  const isSubtitleRunning = RUNNING_SUBTITLE_PHASES.has(subtitleJob?.phase)
  const subtitlePercent = Math.round(
    Math.min(100, Math.max(0, Number.isFinite(subtitleJob?.percent) ? subtitleJob.percent : 0)),
  )
  const subtitleTone =
    subtitleJob?.phase === 'failed'
      ? 'border-red-400/40 text-red-200'
      : subtitleJob?.phase === 'paused' || subtitleJob?.phase === 'pausing'
        ? 'border-amber-400/40 text-amber-200'
        : isSubtitleRunning
          ? 'border-cyan-400/40 text-cyan-200'
          : 'border-indigo-400/40 text-indigo-200'
  const ratingLabel = formatRating(video.rating)
  const infoItems = [
    ['별점', ratingLabel],
    ['재생 횟수', video.playCount.toLocaleString()],
    ['재생 시간', formatDuration(video.playTimeSec)],
    ['마지막 재생', formatDateTime(video.lastPlayedAt)],
  ]
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`group flex h-[440px] flex-col overflow-hidden rounded-xl border bg-zinc-900 text-left transition-colors ${isSelected ? 'border-indigo-500 ring-1 ring-indigo-500/40' : isSubtitleRunning ? 'border-cyan-500/70 hover:border-cyan-400' : 'border-zinc-800 hover:border-zinc-500'}`}
    >
      <div className={'relative aspect-video w-full flex-none overflow-hidden bg-zinc-800'}>
        {primary ? (
          <ProtectedThumbnail
            src={toLocalMediaUrl(primary, video.id)}
            alt={displayTitle}
            className={
              'h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]'
            }
          />
        ) : (
          <div className={'flex h-full items-center justify-center text-zinc-600'}>
            <svg
              xmlns={'http://www.w3.org/2000/svg'}
              className={'h-8 w-8'}
              fill={'none'}
              viewBox={'0 0 24 24'}
              stroke={'currentColor'}
            >
              <path
                strokeLinecap={'round'}
                strokeLinejoin={'round'}
                strokeWidth={1.5}
                d={
                  'M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14M4 8a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V8z'
                }
              />
            </svg>
          </div>
        )}
        <div
          className={
            'absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent p-2.5'
          }
        >
          <div className={'flex flex-wrap items-center gap-1.5'}>
            <span
              className={`rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${hasThumbnail ? 'bg-emerald-500/85 text-white' : 'bg-amber-400/90 text-black'}`}
            >
              {hasThumbnail ? '썸네일' : '썸네일 없음'}
            </span>
            <span
              className={`rounded px-2 py-1 text-[10px] font-semibold tracking-wide ${hasSubtitles ? 'bg-sky-500/85 text-white' : 'bg-zinc-700/85 text-zinc-200'}`}
            >
              {hasSubtitles ? '자막 있음' : '자막 없음'}
            </span>
          </div>
          {video.tags && (
            <span
              className={
                'ml-2 max-w-[58%] truncate rounded bg-black/55 px-2 py-1 text-[10px] text-zinc-100'
              }
            >
              {firstTag(video.tags)}
            </span>
          )}
        </div>
        {subtitleLabel && (
          <div
            role="status"
            aria-label={`${displayTitle} 자막 작업`}
            aria-live="off"
            title={subtitleJob.message || subtitleLabel}
            className={`absolute inset-x-0 bottom-0 border-t bg-zinc-950/95 ${subtitleTone}`}
          >
            <div className="flex min-w-0 items-center gap-2 px-2.5 py-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full bg-current ${isSubtitleRunning ? 'motion-safe:animate-pulse' : ''}`}
              />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">{subtitleLabel}</span>
              {isSubtitleRunning && (
                <span className="shrink-0 text-[11px] font-medium tabular-nums">
                  {subtitlePercent}%
                </span>
              )}
            </div>
            {isSubtitleRunning && (
              <div
                role="progressbar"
                aria-label={`${displayTitle} 자막 생성 단계 진행률`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={subtitlePercent}
                aria-valuetext={`${subtitleLabel}, 현재 단계 ${subtitlePercent}%`}
                className="h-1 bg-white/10"
              >
                <div
                  className="h-full bg-current transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${subtitlePercent}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className={'grid flex-1 grid-rows-[56px_132px_64px_18px] gap-2.5 px-3 py-3'}>
        <div className={'min-w-0 overflow-hidden'}>
          <div className={'mb-1 flex items-center gap-2'}>
            <div className={'flex items-center gap-0.5'} aria-label={`별점 ${ratingLabel}`}>
              {Array.from(
                {
                  length: 5,
                },
                (_, index) => {
                  const starIndex = index + 1
                  const isFilled = video.rating >= starIndex
                  const isHalfFilled = !isFilled && video.rating >= starIndex - 0.5
                  return (
                    <span
                      className={`text-sm leading-none ${isFilled || isHalfFilled ? 'text-yellow-400' : 'text-zinc-700'}`}
                      key={starIndex}
                    >
                      {isHalfFilled ? '⯨' : '★'}
                    </span>
                  )
                },
              )}
            </div>
            <span
              className={
                'rounded bg-yellow-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-300'
              }
            >
              {ratingLabel}
            </span>
          </div>
          <p
            className={
              'line-clamp-2 h-9 overflow-hidden break-words text-sm font-semibold leading-[1.125rem] text-zinc-100'
            }
            title={displayTitle}
          >
            {displayTitle}
          </p>
          <p
            className={'mt-1 h-4 truncate text-[11px] leading-4 text-zinc-500'}
            title={video.fileName}
          >
            {video.fileName}
          </p>
        </div>
        <div
          className={
            'grid h-[132px] grid-cols-2 gap-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-2.5'
          }
        >
          {infoItems.map(([label, value]) => (
            <div
              className={
                'flex h-[52px] min-w-0 flex-col justify-between rounded-md border border-zinc-800/80 bg-zinc-900/70 px-2.5 py-2'
              }
              key={label}
            >
              <p className={'truncate text-[10px] tracking-wide text-zinc-500'}>{label}</p>
              <p className={'truncate text-xs font-medium text-zinc-100'} title={value}>
                {value}
              </p>
            </div>
          ))}
        </div>
        <div className={'rounded-lg border border-zinc-800 bg-zinc-950/40 p-2.5'}>
          <p className={'text-[10px] uppercase tracking-wide text-zinc-600'}>{'메모'}</p>
          {video.memo ? (
            <p
              className={'mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs text-zinc-300'}
            >
              {video.memo}
            </p>
          ) : (
            <p className={'mt-1 text-xs text-zinc-600'}>{'메모 없음'}</p>
          )}
        </div>
        <div className={'flex items-center justify-between text-[11px] text-zinc-500'}>
          <span>
            {'이어보기 '}
            {formatDuration(video.resumePosSec)}
          </span>
          <span>{hasSubtitles ? '자막 준비됨' : '자막 없음'}</span>
        </div>
      </div>
    </button>
  )
}
const VideoCard$1 = React.memo(VideoCard)
function formatDuration(sec) {
  const safeSec = Math.max(0, Math.floor(sec))
  const hours = Math.floor(safeSec / 3600)
  const minutes = Math.floor((safeSec % 3600) / 60)
  const seconds = Math.floor(safeSec % 60)
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
function formatDateTime(value) {
  if (!value) return '없음'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString()
}
function firstTag(tags2) {
  return tags2.split(',')[0]?.trim() || tags2
}
function formatRating(rating) {
  return `${Number(rating || 0).toFixed(1)}/5`
}
export default VideoCard$1
