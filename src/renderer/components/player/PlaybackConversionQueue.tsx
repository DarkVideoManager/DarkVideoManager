import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { PlaybackConversionJob } from '@shared/playbackConversion'
import { useLibraries } from '../../api/useLibraries'
import {
  usePlaybackConversionAction,
  usePlaybackConversionQueue,
} from '../../api/usePlaybackConversionQueue'

export function conversionStatus(job: PlaybackConversionJob): string {
  if (job.status === 'queued')
    return job.queuePosition ? `대기 ${job.queuePosition}번째` : '대기 중'
  if (job.status === 'paused') return '일시정지됨'
  if (job.status === 'failed') return '변환 실패'
  if (job.status === 'completed') return '변환 완료'
  return {
    waiting: '차례를 기다리는 중',
    checking: '영상 확인 중',
    remuxing: '재생 형식 정리 중',
    transcoding: '영상 변환 중',
    validating: '변환본 확인 중',
    completed: '변환 완료',
  }[job.phase]
}

function timeLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export function ConversionProgress({ job }: { job: PlaybackConversionJob }) {
  const percent = job.progress === null ? null : Math.max(0, Math.min(100, job.progress))
  return (
    <div className="min-w-0">
      <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-indigo-200">
        <span>{conversionStatus(job)}</span>
        {percent !== null && <span className="tabular-nums">{Math.floor(percent)}%</span>}
        {job.durationSec > 0 && job.status === 'running' && (
          <span className="tabular-nums text-zinc-400">
            {timeLabel(job.processedSec)} / {timeLabel(job.durationSec)}
          </span>
        )}
      </p>
      <div
        role="progressbar"
        aria-label={`${job.title || job.fileName} 변환 진행률`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={percent === null ? conversionStatus(job) : `${Math.floor(percent)}%`}
        className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-700"
      >
        <div
          className={`h-full rounded ${job.status === 'failed' ? 'bg-red-400' : job.status === 'paused' ? 'bg-amber-400' : 'bg-indigo-400'} ${percent === null && job.status === 'running' ? 'animate-pulse' : ''}`}
          style={{
            width: percent === null ? (job.status === 'running' ? '25%' : '0%') : `${percent}%`,
          }}
        />
      </div>
    </div>
  )
}

export function ConversionQueueItem({
  job,
  libraryName,
  compact = false,
}: {
  job: PlaybackConversionJob
  libraryName?: string
  compact?: boolean
}) {
  const navigate = useNavigate()
  const action = usePlaybackConversionAction(job)
  const play = useMutation({
    mutationFn: async () => {
      const result = await window.api.library.open(job.libraryId)
      if (!result.ok) throw new Error(result.error)
    },
    onSuccess: () => navigate(`/player/${job.libraryId}/${job.videoId}`),
  })
  const busy = action.isPending || play.isPending
  const active = ['queued', 'running'].includes(job.status)
  const buttonClass =
    'rounded border border-zinc-600 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50'
  return (
    <article
      aria-label={job.title || job.fileName}
      className={`min-w-0 rounded-lg border border-zinc-700/80 bg-zinc-900/90 p-3 text-left ${compact ? '' : 'sm:flex sm:items-center sm:gap-4'}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-100" title={job.fileName}>
          {job.title || job.fileName}
        </p>
        {libraryName && <p className="mb-1 truncate text-[11px] text-zinc-500">{libraryName}</p>}
        <ConversionProgress job={job} />
        {job.status === 'paused' && (
          <p className="mt-2 text-xs text-amber-200/80">
            재개하면 이 영상의 변환을 처음부터 시작합니다.
          </p>
        )}
        {job.status !== 'paused' && job.error && (
          <p
            className={`mt-2 break-words text-xs ${job.status === 'failed' ? 'text-red-300' : 'text-amber-200'}`}
          >
            {job.error}
          </p>
        )}
        {action.error && (
          <p role="alert" className="mt-2 text-xs text-red-300">
            {action.error.message}
          </p>
        )}
        {play.error && (
          <p role="alert" className="mt-2 text-xs text-red-300">
            {play.error.message}
          </p>
        )}
      </div>
      <div className={`mt-3 flex shrink-0 flex-wrap gap-2 ${compact ? '' : 'sm:mt-0'}`}>
        {active && (
          <button
            type="button"
            disabled={busy}
            title="재개하면 변환을 처음부터 시작합니다."
            className={buttonClass}
            onClick={() => action.mutate('pause')}
          >
            {action.isPending && action.variables === 'pause' ? '일시정지 중...' : '일시정지'}
          </button>
        )}
        {['paused', 'failed'].includes(job.status) && (
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => action.mutate('resume')}
          >
            {action.isPending && action.variables === 'resume'
              ? '대기열에 추가 중...'
              : job.status === 'failed'
                ? '다시 시도'
                : '재개'}
          </button>
        )}
        {job.status === 'completed' && (
          <button
            type="button"
            disabled={busy}
            className={buttonClass}
            onClick={() => play.mutate()}
          >
            {play.isPending ? '여는 중...' : '재생'}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          className={buttonClass}
          title={active ? '변환을 취소하고 대기열에서 제거합니다.' : '목록에서 제거합니다.'}
          onClick={() => action.mutate('remove')}
        >
          {action.isPending && action.variables === 'remove' ? '삭제 중...' : '삭제'}
        </button>
      </div>
    </article>
  )
}

export default function PlaybackConversionQueue() {
  const queue = usePlaybackConversionQueue()
  const { data: libraries = [] } = useLibraries()
  const [expanded, setExpanded] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const jobs = queue.data ?? []
  const unfinished = jobs.filter((job) => ['queued', 'running', 'paused'].includes(job.status))
  const failures = jobs.filter((job) => job.status === 'failed')
  const completed = jobs
    .filter((job) => job.status === 'completed')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const visible = [...unfinished, ...failures, ...(showAll ? completed : completed.slice(0, 3))]
  if (!jobs.length && !queue.error) return null
  return (
    <section
      data-testid="playback-conversion-queue"
      aria-label="영상 변환 대기열"
      className="shrink-0 border-b border-zinc-800 bg-indigo-950/10 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold text-zinc-100">영상 변환 대기열</h2>
          <p className="text-xs text-zinc-400">
            {unfinished.length ? `진행·대기 ${unfinished.length}개` : '진행 중인 변환 없음'}
            {failures.length > 0 && ` · 실패 ${failures.length}개`}
            {completed.length > 0 && ` · 완료 ${completed.length}개`}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="text-xs text-zinc-300 hover:text-white"
        >
          {expanded ? '접기' : '펼치기'}
        </button>
      </div>
      {queue.error && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-300">
          <span>변환 대기열을 불러오지 못했습니다: {queue.error.message}</span>
          <button type="button" onClick={() => void queue.refetch()} className="underline">
            다시 불러오기
          </button>
        </div>
      )}
      {expanded && visible.length > 0 && (
        <>
          <p className="mt-1 text-xs text-zinc-500">
            다른 영상을 둘러보는 동안에도 순서대로 변환합니다.
          </p>
          <div className="mt-2 max-h-60 space-y-2 overflow-y-auto pr-1">
            {visible.map((job) => (
              <ConversionQueueItem
                key={job.id}
                job={job}
                libraryName={
                  libraries.find((library) => library.id === job.libraryId)?.name ??
                  '다른 라이브러리'
                }
              />
            ))}
          </div>
          {completed.length > 3 && (
            <button
              type="button"
              className="mt-2 text-xs text-zinc-400 underline"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? '최근 완료만 보기' : `완료 ${completed.length}개 모두 보기`}
            </button>
          )}
        </>
      )}
    </section>
  )
}
