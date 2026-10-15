const PHASE_LABELS = {
  queued: '썸네일 생성 대기',
  running: '썸네일 생성 중',
  cancelling: '썸네일 취소 중',
  completed: '썸네일 생성 완료',
  failed: '썸네일 생성 실패',
  cancelled: '썸네일 생성 취소됨',
}

export function isThumbnailJobActive(job) {
  return ['queued', 'running', 'cancelling'].includes(job?.phase)
}

export default function ThumbnailJobStatus({
  job,
  label,
  onCancel,
  isCancelling,
  cancelError,
  compact = false,
}) {
  if (!job) return null
  const active = isThumbnailJobActive(job)
  const cancelling = isCancelling || job.phase === 'cancelling'
  const total = Math.max(0, job.total)
  const completed = Math.min(total, Math.max(0, job.completed))
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  const reason = job.error || (job.phase === 'cancelled' ? '요청에 따라 작업을 취소했습니다.' : '')
  return (
    <div
      className={`relative rounded border bg-zinc-950/95 p-2 ${compact && active ? 'pr-14' : ''} ${job.phase === 'failed' || cancelError ? 'border-red-500/50 text-red-200' : 'border-indigo-400/40 text-indigo-200'}`}
    >
      <div role="status" aria-label={label} aria-live="off">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-medium">{PHASE_LABELS[job.phase]}</span>
          {total > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums">
              {completed}/{total}
            </span>
          )}
        </div>
        {active && (
          <div
            role="progressbar"
            aria-label={`${label} 진행률`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${completed} / ${total}개 완료`}
            className="mt-1.5 h-1 overflow-hidden rounded bg-white/10"
          >
            <div className="h-full bg-indigo-400" style={{ width: `${percent}%` }} />
          </div>
        )}
        {reason && (
          <p title={reason} className={`mt-1 text-[11px] ${compact ? 'truncate' : 'break-words'}`}>
            {reason}
          </p>
        )}
      </div>
      {active && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          aria-label={`${label} 취소`}
          className={`${compact ? 'absolute right-2 top-2' : 'mt-1.5'} rounded bg-zinc-700 px-2 py-0.5 text-[11px] text-zinc-100 hover:bg-zinc-600 disabled:opacity-50`}
        >
          {cancelling ? '취소 중...' : '취소'}
        </button>
      )}
      {cancelError && (
        <p
          role="alert"
          title={cancelError}
          className={`mt-1 text-[11px] text-red-200 ${compact ? 'truncate' : 'break-words'}`}
        >
          {cancelError}
        </p>
      )}
    </div>
  )
}
