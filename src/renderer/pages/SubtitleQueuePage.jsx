import * as React from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLibraries } from '../api/useLibraries'
import SubtitleTranslationSettings from '../components/library/SubtitleTranslationSettings'
import SubtitleEnvironmentSetup from '../components/library/SubtitleEnvironmentSetup'
import { requestPrivacyExit } from '../components/privacy/PrivacyBoundary'

const terminalPhases = new Set(['completed', 'cancelled', 'failed'])
const transitionPhases = new Set(['pausing', 'removing'])
const phaseLabels = {
  queued: '대기 중',
  preparing: '음성 준비 중',
  loading: '모델 불러오는 중',
  transcribing: '원어 자막 생성 중',
  translating: '한국어 번역 중',
  saving: '자막 저장 중',
  pausing: '일시정지 중',
  paused: '일시정지됨',
  removing: '삭제 중',
  completed: '완료',
  cancelled: '취소됨',
  failed: '실패',
}
const languageLabels = {
  auto: '언어 자동 감지',
  ja: '일본어',
  en: '영어',
  ko: '한국어',
  zh: '중국어',
}
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

function QueueItem({ job, libraryName }) {
  const queryClient = useQueryClient()
  const action = useMutation({
    mutationFn: async (operation) => {
      const result = await window.api.subtitles[`${operation}Job`](job.id)
      if (!result.ok) throw new Error(result.error)
      if (!result.value)
        throw new Error('작업 상태가 변경되었습니다. 목록을 새로고침한 뒤 다시 시도해 주세요.')
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['subtitle-queue'] })
      await queryClient.invalidateQueries({
        queryKey: ['subtitle-generation', job.libraryId, job.videoId],
      })
    },
  })
  const title = job.title || job.videoId
  const percent = Math.max(0, Math.min(100, Math.round(job.percent ?? 0)))
  const terminal = terminalPhases.has(job.phase)
  const resumable = job.phase === 'paused' || job.phase === 'failed'
  const busy = action.isPending || transitionPhases.has(job.phase)
  const options = job.options
  return (
    <li>
      <article
        aria-label={title}
        className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-medium text-zinc-100">{title}</h2>
            <p className="mt-1 text-xs text-zinc-500">{libraryName || '라이브러리 정보 없음'}</p>
            {options && (
              <p className="mt-2 text-xs text-zinc-400">
                {options.model} · {languageLabels[options.language] || options.language} ·{' '}
                {options.translateToKorean ? '원어 + 한국어 번역' : '원어 자막'}
              </p>
            )}
          </div>
          <p
            role="status"
            className={`text-xs ${job.phase === 'failed' ? 'text-red-300' : job.phase === 'completed' ? 'text-emerald-300' : 'text-indigo-300'}`}
          >
            {phaseLabels[job.phase] || job.phase}
            {!terminal && ` · ${percent}%`}
          </p>
        </div>
        {!terminal && (
          <progress
            aria-label={`${title} 자막 생성 진행률`}
            max={100}
            value={percent}
            className="h-1.5 w-full accent-indigo-500"
          />
        )}
        {job.message && (
          <p className="break-words text-xs leading-relaxed text-zinc-400">{job.message}</p>
        )}
        {!!job.outputPaths?.length && (
          <ul aria-label="생성된 자막 파일" className="space-y-1 text-xs text-zinc-500">
            {job.outputPaths.map((path) => (
              <li key={path} title={path} className="break-all">
                {path.split(/[\\/]/).pop()}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {resumable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => action.mutate('resume')}
              className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {action.isPending && action.variables === 'resume'
                ? '재개 요청 중...'
                : job.phase === 'failed'
                  ? '재개 · 다시 시도'
                  : '재개'}
            </button>
          ) : (
            !terminal && (
              <button
                type="button"
                disabled={busy}
                onClick={() => action.mutate('pause')}
                className="rounded bg-zinc-700 px-3 py-1.5 text-xs text-white hover:bg-zinc-600 disabled:opacity-50"
              >
                {(action.isPending && action.variables === 'pause') || job.phase === 'pausing'
                  ? '일시정지 중...'
                  : '일시정지'}
              </button>
            )
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => action.mutate('remove')}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {(action.isPending && action.variables === 'remove') || job.phase === 'removing'
              ? '삭제 중...'
              : '삭제'}
          </button>
        </div>
        {action.error && (
          <p role="alert" className="break-words text-xs text-red-300">
            {errorMessage(action.error)}
          </p>
        )}
      </article>
    </li>
  )
}

export default function SubtitleQueuePage() {
  const queryClient = useQueryClient()
  const { data: libraries = [] } = useLibraries()
  const completed = React.useRef(new Map())
  const queue = useQuery({
    queryKey: ['subtitle-queue'],
    queryFn: async () => {
      const result = await window.api.subtitles.listQueue()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminalPhases.has(job.phase)) ? 1000 : false,
    refetchIntervalInBackground: true,
    retry: false,
  })
  const jobs = queue.data || []
  React.useEffect(() => {
    for (const job of jobs) {
      if (!terminalPhases.has(job.phase)) {
        completed.current.delete(job.id)
        continue
      }
      const signature = JSON.stringify([job.phase, job.message, job.outputPaths])
      if (completed.current.get(job.id) === signature) continue
      completed.current.set(job.id, signature)
      for (const key of ['subtitles', 'subtitle-tracks', 'subtitle-cues', 'video']) {
        void queryClient.invalidateQueries({ queryKey: [key, job.libraryId, job.videoId] })
      }
      void queryClient.invalidateQueries({ queryKey: ['videos', job.libraryId] })
      void queryClient.invalidateQueries({ queryKey: ['stats', job.libraryId] })
      void queryClient.invalidateQueries({
        queryKey: ['subtitle-generation', job.libraryId, job.videoId],
      })
    }
  }, [jobs, queryClient])
  React.useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select'))
      )
        return
      event.preventDefault()
      requestPrivacyExit()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
  const unfinished = jobs.filter((job) => !terminalPhases.has(job.phase))
  return (
    <section aria-label="자막 생성 큐" className="w-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">자막 생성</h1>
            <p className="mt-1 text-xs text-zinc-400">
              모든 라이브러리의 작업 · 미완료 {unfinished.length}개 / 전체 {jobs.length}개
            </p>
          </div>
          <button
            type="button"
            disabled={queue.isFetching}
            onClick={() => void queue.refetch()}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            새로고침
          </button>
        </div>
        <SubtitleEnvironmentSetup />
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs leading-relaxed text-zinc-400">
          <p>
            라이브러리에서 영상 선택 → 정보 → AI 자막 생성으로 작업을 추가하세요. 대기 중인 작업은
            순서대로 처리합니다.
          </p>
          <p>
            대기·진행·일시정지 작업이 있으면 ESC 또는 창 닫기(X)로 닫아도 트레이에 남습니다. 트레이
            아이콘을 두 번 클릭하면 다시 열립니다.
          </p>
          <p>
            트레이 메뉴의 완전히 종료를 사용하면 미완료 큐를 보관합니다. 다음 실행에서 재개를 누르면
            이어갑니다. 작업을 삭제해도 이미 저장된 자막 파일은 보존합니다.
          </p>
        </div>
        <SubtitleTranslationSettings />
        {queue.isPending && (
          <p role="status" className="text-sm text-zinc-400">
            자막 생성 큐를 불러오는 중...
          </p>
        )}
        {queue.error && (
          <p role="alert" className="break-words text-sm text-red-300">
            큐를 불러오지 못했습니다: {errorMessage(queue.error)}
          </p>
        )}
        {!queue.isPending && !queue.error && jobs.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-700 py-12 text-center">
            <p className="text-sm text-zinc-400">자막 생성 큐가 비어 있습니다.</p>
            <Link to="/" className="mt-3 inline-block text-sm text-indigo-300 underline">
              라이브러리에서 영상 선택
            </Link>
          </div>
        )}
        <ul aria-label="자막 작업 목록" className="space-y-3">
          {jobs.map((job) => (
            <QueueItem
              key={job.id}
              job={job}
              libraryName={libraries.find((library) => library.id === job.libraryId)?.name}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}
