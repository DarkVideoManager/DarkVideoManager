import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { SubtitleGenerationOptions } from '../../src/shared/types'
import { DEMO_LIBRARY_ID } from './data'

const terminal = new Set(['completed', 'cancelled', 'failed'])

export default function SubtitleExperience() {
  const client = useQueryClient()
  const [videoId, setVideoId] = useState('baseball-3')
  const [language, setLanguage] = useState<SubtitleGenerationOptions['language']>('en')
  const [translateToKorean, setTranslateToKorean] = useState(true)
  const videos = useQuery({
    queryKey: ['videos', DEMO_LIBRARY_ID, 'demo-subtitle-samples'],
    queryFn: async () => {
      const result = await window.api.videos.search(DEMO_LIBRARY_ID, {})
      if (!result.ok) throw new Error(result.error)
      return result.value.videos
    },
  })
  const selectedId = videos.data?.some((video) => video.id === videoId)
    ? videoId
    : (videos.data?.[0]?.id ?? '')
  const queryKey = ['subtitle-generation', DEMO_LIBRARY_ID, selectedId]
  const status = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await window.api.subtitles.getGenerationStatus(DEMO_LIBRARY_ID, selectedId)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled: Boolean(selectedId),
    refetchInterval: (query) =>
      query.state.data && !terminal.has(query.state.data.phase) ? 1000 : false,
    refetchIntervalInBackground: true,
  })
  const start = useMutation({
    mutationFn: async () => {
      const result = await window.api.subtitles.generate(DEMO_LIBRARY_ID, selectedId, {
        model: 'base',
        language,
        translateToKorean,
      })
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: async (job) => {
      client.setQueryData(['subtitle-generation', job.libraryId, job.videoId], job)
      await client.invalidateQueries({ queryKey: ['subtitle-queue'] })
    },
  })
  const active = Boolean(status.data && !terminal.has(status.data.phase))
  const error = start.error || status.error || videos.error
  return (
    <section
      id="subtitle-environment"
      aria-label="자막 생성 시뮬레이션"
      className="space-y-4 rounded-lg border border-indigo-500/40 bg-indigo-950/20 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">직접 자막을 만들어 보세요</h2>
        <span className="rounded bg-indigo-500/20 px-2 py-1 text-[11px] text-indigo-200">
          브라우저 시뮬레이션
        </span>
      </div>
      <p className="text-xs leading-relaxed text-zinc-300">
        영상 선택 → 생성 과정 체험 → 자막 탐색. 미리 작성한 장면 설명으로 원어 자막과 한국어 번역이
        만들어지는 과정을 재현합니다. 실제 AI 분석이나 프로그램 설치, 외부 전송은 하지 않습니다.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-zinc-400">
          <span>체험할 야구 영상</span>
          <select
            aria-label="체험할 야구 영상"
            className="block w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-zinc-100"
            value={selectedId}
            disabled={start.isPending || !videos.data?.length}
            onChange={(event) => {
              setVideoId(event.target.value)
              start.reset()
            }}
          >
            {videos.data?.map((video) => (
              <option key={video.id} value={video.id}>
                {video.title || video.fileName}
                {video.hasSubtitles ? '' : ' · 자막 없음'}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-zinc-400">
          <span>체험 자막 언어</span>
          <select
            aria-label="체험 자막 언어"
            className="block w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-zinc-100"
            value={language}
            disabled={start.isPending}
            onChange={(event) =>
              setLanguage(event.target.value as SubtitleGenerationOptions['language'])
            }
          >
            <option value="en">영어</option>
            <option value="ko">한국어</option>
            <option value="ja">일본어</option>
            <option value="zh">중국어</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          className="accent-indigo-500"
          checked={translateToKorean}
          disabled={start.isPending}
          onChange={(event) => setTranslateToKorean(event.target.checked)}
        />
        한국어 번역 자막도 함께 체험
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={
            !selectedId || active || start.isPending || status.isPending || Boolean(status.error)
          }
          onClick={() => start.mutate()}
          className="rounded bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {start.isPending
            ? '작업 추가 중…'
            : active
              ? '아래 작업 목록에서 진행 상황 확인'
              : '선택 영상 자막 생성 체험'}
        </button>
        {status.data?.phase === 'completed' && (
          <Link
            className="text-xs text-indigo-200 underline"
            to={`/player/${DEMO_LIBRARY_ID}/${selectedId}?panel=subtitles`}
          >
            완료된 자막 탐색하기 →
          </Link>
        )}
      </div>
      {active && status.data && (
        <div className="space-y-2" role="status">
          <p className="text-xs text-indigo-200">
            {Math.round(status.data.percent ?? 0)}% · {status.data.message}
          </p>
          <progress
            aria-label="선택 영상 체험 진행률"
            className="h-1.5 w-full accent-indigo-500"
            max={100}
            value={status.data.percent ?? 0}
          />
          <button
            type="button"
            className="text-xs text-indigo-200 underline"
            onClick={() =>
              document
                .querySelector('[aria-label="자막 작업 목록"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          >
            일시정지·재개 관리 ↓
          </button>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-400">
        예시 완료 작업이 준비되어 있습니다. 새 작업은 약 15초 동안 진행되며, 아래 목록에서
        일시정지·재개·삭제를 체험할 수 있습니다.
      </p>
      {error && (
        <p role="alert" className="text-xs text-amber-200">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </section>
  )
}
