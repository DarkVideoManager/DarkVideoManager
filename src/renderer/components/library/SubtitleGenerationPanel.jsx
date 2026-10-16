import SubtitleGpuGuidance from './SubtitleGpuGuidance'
import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import SubtitleProcessingStatus from './SubtitleProcessingStatus'
import SubtitleModelGuide from './SubtitleModelGuide'
import { SubtitleStartGuidance, SubtitlePrivacyGuidance } from './SubtitleGuidance'

const terminalPhases = new Set(['completed', 'cancelled', 'failed'])
const phaseLabels = {
  queued: '대기 중',
  pausing: '일시정지 중',
  paused: '일시정지됨',
  removing: '삭제 중',
  preparing: '음성 준비 중',
  loading: '모델 불러오는 중',
  transcribing: '원어 자막 생성 중',
  translating: '한국어 번역 중',
  saving: '자막 저장 중',
  completed: '자막 생성 완료',
  cancelled: '자막 생성 취소됨',
  failed: '자막 생성 실패',
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export default function SubtitleGenerationPanel({ libraryId, videoId, disabled = false }) {
  const queryClient = useQueryClient()
  const [model, setModel] = React.useState('base')
  const [language, setLanguage] = React.useState('auto')
  const [translateToKorean, setTranslateToKorean] = React.useState(true)
  const [regeneration, setRegeneration] = React.useState(null)
  const regenerationSubmitted = React.useRef(false)
  const confirmationTitleId = React.useId()
  const handledCompletion = React.useRef(null)
  const queryKey = ['subtitle-generation', libraryId, videoId]
  const subtitles = useQuery({
    queryKey: ['subtitles', libraryId, videoId],
    queryFn: async () => {
      const result = await window.api.subtitles.getForVideo(libraryId, videoId)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  })
  const engine = useQuery({
    queryKey: ['subtitle-engine'],
    queryFn: async () => {
      const result = await window.api.subtitles.getEngineInfo()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: 60_000,
    retry: false,
  })
  const status = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await window.api.subtitles.getGenerationStatus(libraryId, videoId)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => {
      const job = query.state.data
      return job && !terminalPhases.has(job.phase) ? 1000 : false
    },
    refetchIntervalInBackground: true,
    retry: false,
  })
  const job = status.data
  const active = Boolean(job && !terminalPhases.has(job.phase))
  const generate = useMutation({
    mutationFn: async (options) => {
      await queryClient.cancelQueries({ queryKey, exact: true })
      const result = await window.api.subtitles.generate(libraryId, videoId, options)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: async (nextJob) => {
      await queryClient.cancelQueries({ queryKey, exact: true })
      queryClient.setQueryData(queryKey, nextJob)
      await queryClient.invalidateQueries({ queryKey: ['subtitle-queue'] })
    },
  })
  const cancel = useMutation({
    mutationFn: async () => {
      const result = await window.api.subtitles.cancelGeneration(libraryId, videoId)
      if (!result.ok) throw new Error(result.error)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey, exact: true })
      await queryClient.invalidateQueries({ queryKey: ['subtitle-queue'] })
    },
  })
  const regenerate = useMutation({
    mutationFn: async (request) => {
      const key = ['subtitle-generation', request.libraryId, request.videoId]
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const result = await window.api.subtitles.regenerate(
        request.libraryId,
        request.videoId,
        request.tracks.map((track) => track.id),
        request.options,
      )
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: async (nextJob, request) => {
      const key = ['subtitle-generation', request.libraryId, request.videoId]
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      queryClient.setQueryData(key, nextJob)
    },
    onSettled: async (_nextJob, _error, request) => {
      // Deletion can partially succeed before an error, so refresh every affected view.
      const keys = ['subtitles', 'subtitle-tracks', 'subtitle-cues', 'video'].map((key) => [
        key,
        request.libraryId,
        request.videoId,
      ])
      keys.push(
        ['videos', request.libraryId],
        ['stats', request.libraryId],
        ['subtitle-queue'],
        ['subtitle-generation', request.libraryId, request.videoId],
      )
      try {
        await Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: key })))
      } finally {
        regenerationSubmitted.current = false
      }
    },
  })

  React.useEffect(() => {
    if (!job || !terminalPhases.has(job.phase)) {
      if (job && !terminalPhases.has(job.phase)) handledCompletion.current = null
      return
    }
    const signature = JSON.stringify([job.id, job.phase, job.outputPaths, job.message])
    if (handledCompletion.current === signature) return
    handledCompletion.current = signature
    for (const key of ['subtitles', 'subtitle-tracks', 'subtitle-cues', 'video']) {
      void queryClient.invalidateQueries({ queryKey: [key, libraryId, videoId] })
    }
    void queryClient.invalidateQueries({ queryKey: ['videos', libraryId] })
    void queryClient.invalidateQueries({ queryKey: ['stats', libraryId] })
  }, [job, libraryId, queryClient, videoId])

  const externalTracks = (subtitles.data ?? []).filter((track) => !track.isEmbedded)
  const embeddedTracks = (subtitles.data ?? []).filter((track) => track.isEmbedded)
  const busy = active || generate.isPending || regenerate.isPending || Boolean(regeneration)
  const percent = Math.max(0, Math.min(100, Math.round(job?.percent ?? 0)))
  const actionError = regenerate.error || generate.error || cancel.error
  return (
    <section
      aria-label="AI 자막 생성"
      className="space-y-3 rounded border border-zinc-700 bg-zinc-950/40 p-3"
    >
      <h3 className="text-sm font-semibold text-zinc-100">AI 자막 생성</h3>
      <SubtitleStartGuidance />
      <SubtitleGpuGuidance />
      <p className="text-xs leading-relaxed text-zinc-400">
        시작하면 작업 큐에 추가해 순서대로 처리합니다. 다른 영상도 이어서 추가할 수 있습니다.
      </p>
      <Link
        to="/subtitles"
        className="inline-block text-xs text-indigo-300 underline hover:text-indigo-200"
      >
        자막 생성 큐 관리 · 일시정지 / 재개 / 삭제
      </Link>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-xs text-zinc-400">
          <span>음성 인식 모델</span>
          <select
            aria-label="음성 인식 모델"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={disabled || busy}
            className="w-full rounded bg-zinc-800 p-1.5 text-zinc-100 disabled:opacity-50"
          >
            <option value="tiny">tiny · 소형</option>
            <option value="base">base · 기본</option>
            <option value="small">small</option>
            <option value="medium">medium</option>
            <option value="large-v2">large-v2 · 대형</option>
            <option value="large-v3">large-v3 · 대형</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>영상 언어</span>
          <select
            aria-label="영상 언어"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            disabled={disabled || busy}
            className="w-full rounded bg-zinc-800 p-1.5 text-zinc-100 disabled:opacity-50"
          >
            <option value="auto">자동 감지</option>
            <option value="ja">일본어</option>
            <option value="en">영어</option>
            <option value="ko">한국어</option>
            <option value="zh">중국어</option>
          </select>
        </label>
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-400" aria-live="polite">
        {model.startsWith('large')
          ? '대형 모델이 없으면 약 3.1GB를 다운로드하며 실행 시 더 많은 메모리가 필요합니다. 먼저 짧은 영상으로 확인하세요.'
          : '선택한 모델이 없으면 처음 생성할 때 다운로드합니다. 기본 base부터 짧은 영상으로 확인할 수 있습니다.'}{' '}
        모델 변경은 다음에 시작하는 작업에 적용됩니다.
      </p>
      <SubtitleModelGuide model={model} language={language} />
      <label className="flex items-center gap-2 text-xs text-zinc-200">
        <input
          type="checkbox"
          checked={translateToKorean}
          onChange={(event) => setTranslateToKorean(event.target.checked)}
          disabled={disabled || busy}
          className="accent-indigo-500"
        />
        한국어 번역 자막도 생성
      </label>
      <p className="text-[11px] leading-relaxed text-zinc-400">
        음성 인식은 내 PC에서 처리합니다. Google Cloud 사용은 기본으로 꺼져 있으며, 자막 생성 탭에서
        사용을 켜고 API 키를 저장한 경우 인식한 텍스트를 전송합니다. 사용을 끄거나 키·한도가 없거나
        요청에 실패하면 PC의 Ollama를 사용합니다.
      </p>
      <SubtitlePrivacyGuidance />
      <p className="text-[11px] leading-relaxed text-zinc-500">
        ‘자막 생성 시작’은 기존 자막을 보존합니다. 영상 옆에 .ai.srt와 .ai.ko.srt를 저장하며, 같은
        이름이 있으면 번호를 붙입니다.
      </p>
      {embeddedTracks.length > 0 && (
        <p className="text-[11px] leading-relaxed text-zinc-400">
          영상에 내장된 자막은 삭제하지 않습니다. 새 자막은 별도 파일로 생성합니다.
        </p>
      )}
      {(engine.isPending || engine.isFetching) && (
        <p className="text-xs text-zinc-400">자막 생성 환경 확인 중...</p>
      )}
      {!engine.error && engine.data?.available && engine.data.message && (
        <p className="text-xs leading-relaxed text-emerald-300">{engine.data.message}</p>
      )}
      {(engine.error || engine.data?.available === false) && (
        <div className="space-y-2 rounded bg-amber-950/30 p-2 text-xs text-amber-200">
          <p role="alert" className="break-words">
            {engine.error ? errorMessage(engine.error) : engine.data.message}
          </p>
          <p>자막 생성 탭에서 필요한 프로그램과 모델을 자동으로 설치할 수 있습니다.</p>
          <Link
            to="/subtitles#subtitle-environment"
            className="inline-block rounded bg-indigo-600 px-2 py-1 text-white hover:bg-indigo-500"
          >
            자막 환경 자동 설치 열기
          </Link>
          <button
            type="button"
            onClick={() => void engine.refetch()}
            disabled={engine.isFetching}
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            환경 다시 확인
          </button>
        </div>
      )}
      {status.error && (
        <div className="space-y-1 text-xs text-red-300">
          <p role="alert">작업 상태를 확인하지 못했습니다: {errorMessage(status.error)}</p>
          <button type="button" onClick={() => void status.refetch()} className="underline">
            상태 다시 확인
          </button>
        </div>
      )}
      {subtitles.error && (
        <div className="space-y-1 text-xs text-red-300">
          <p role="alert">기존 자막을 확인하지 못했습니다: {errorMessage(subtitles.error)}</p>
          <button type="button" onClick={() => void subtitles.refetch()} className="underline">
            기존 자막 다시 확인
          </button>
        </div>
      )}
      {job && (
        <div className="space-y-2">
          <p
            role={job.phase === 'failed' ? 'alert' : 'status'}
            className={`break-words text-xs ${job.phase === 'failed' ? 'text-red-300' : job.phase === 'completed' ? 'text-emerald-300' : 'text-zinc-300'}`}
          >
            {phaseLabels[job.phase]}
            {active ? ` · ${percent}%` : ''}
            {job.message && <span className="mt-1 block text-[11px]">{job.message}</span>}
          </p>
          <SubtitleProcessingStatus job={job} />
          {job.storageError && (
            <p role="alert" className="break-words text-xs text-red-300">
              {job.storageError}
            </p>
          )}
          {active && (
            <progress
              aria-label="자막 생성 진행률"
              value={percent}
              max={100}
              className="h-1.5 w-full accent-indigo-500"
            />
          )}
          {!!job.outputPaths?.length && (
            <ul aria-label="생성된 자막 파일" className="space-y-1 text-[11px] text-zinc-400">
              {job.outputPaths.map((filePath) => (
                <li key={filePath} title={filePath} className="break-all">
                  {filePath.split(/[\\/]/).pop()}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {actionError && (
        <p role="alert" className="break-words text-xs text-red-300">
          {errorMessage(actionError)}
        </p>
      )}
      {disabled && (
        <p className="text-xs text-zinc-400">
          제거한 항목은 목록 복구 후 자막을 생성할 수 있습니다.
        </p>
      )}
      {active ? (
        <button
          type="button"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          className="w-full rounded bg-zinc-700 px-3 py-2 text-xs text-white hover:bg-zinc-600 disabled:opacity-50"
        >
          {cancel.isPending ? '취소 요청 중...' : '자막 생성 취소'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            cancel.reset()
            regenerate.reset()
            generate.mutate({ model, language, translateToKorean })
          }}
          disabled={
            disabled ||
            busy ||
            !engine.data?.available ||
            engine.isError ||
            status.isPending ||
            status.isError
          }
          className="w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generate.isPending ? '자막 생성 시작 중...' : '자막 생성 시작'}
        </button>
      )}
      {externalTracks.length > 0 && (
        <button
          type="button"
          onClick={() => {
            generate.reset()
            cancel.reset()
            regenerate.reset()
            setRegeneration({
              libraryId,
              videoId,
              tracks: externalTracks.map((track) => ({ id: track.id, filePath: track.filePath })),
              options: { model, language, translateToKorean },
            })
          }}
          disabled={
            disabled ||
            busy ||
            !engine.data?.available ||
            engine.isError ||
            status.isPending ||
            status.isError ||
            subtitles.isFetching ||
            subtitles.isError
          }
          className="w-full rounded border border-amber-700 px-3 py-2 text-xs text-amber-200 hover:bg-amber-950/40 disabled:opacity-50"
        >
          {regenerate.isPending ? '재생성 큐에 추가 중...' : '기존 자막 삭제 후 재생성'}
        </button>
      )}
      {regeneration && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={confirmationTitleId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setRegeneration(null)
            }
            if (event.key === 'Tab') {
              const buttons = event.currentTarget.querySelectorAll('button:not(:disabled)')
              if (event.shiftKey && document.activeElement === buttons[0]) {
                event.preventDefault()
                buttons[buttons.length - 1]?.focus()
              } else if (
                !event.shiftKey &&
                document.activeElement === buttons[buttons.length - 1]
              ) {
                event.preventDefault()
                buttons[0]?.focus()
              }
            }
          }}
          className="space-y-3 rounded border border-amber-700 bg-zinc-900 p-3 text-xs text-zinc-200"
        >
          <h4 id={confirmationTitleId} className="font-semibold text-amber-200">
            기존 자막 삭제 후 재생성 확인
          </h4>
          <p>
            재생성 작업을 큐에 추가합니다. 차례가 되면 다음 자막 파일을 휴지통으로 이동한 뒤 새
            자막을 생성합니다.
          </p>
          <ul aria-label="삭제할 자막 파일" className="space-y-1">
            {regeneration.tracks.map((track) => (
              <li key={track.id} title={track.filePath} className="break-all">
                {track.filePath.split(/[\\/]/).pop()}
              </li>
            ))}
          </ul>
          <p>
            원본 영상과 내장 자막은 유지합니다. 재생성이 실패하면 기존 자막은 휴지통에서 복원할 수
            있습니다.
          </p>
          <p>
            대기 중에는 기존 자막을 유지합니다. 실행 전에 큐에서 일시정지하거나 삭제할 수 있습니다.
          </p>
          <p>
            생성 설정: {regeneration.options.model} · {regeneration.options.language} ·{' '}
            {regeneration.options.translateToKorean ? '원어 + 한국어 번역' : '원어 자막만'}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => setRegeneration(null)}
              className="rounded bg-zinc-700 px-3 py-2 hover:bg-zinc-600"
            >
              취소
            </button>
            <button
              type="button"
              disabled={disabled || active || regenerate.isPending}
              onClick={() => {
                if (regenerationSubmitted.current) return
                regenerationSubmitted.current = true
                const request = regeneration
                setRegeneration(null)
                regenerate.mutate(request)
              }}
              className="rounded bg-amber-800 px-3 py-2 text-white hover:bg-amber-700 disabled:opacity-50"
            >
              삭제 후 재생성
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
