import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useLibraryStore } from '../store/libraryStore'
import type { DiscoveryPreferences } from '@shared/discovery'
import type { Result } from '@shared/result'

export default function DiscoveryPage() {
  const libraryId = useLibraryStore((state) => state.activeLibraryId)
  const opened = useLibraryStore((state) => state.openedLibraryId)
  if (!libraryId) return <p className="p-6">추천 탐색을 사용하려면 먼저 라이브러리를 선택하세요.</p>
  if (opened !== libraryId) return <p className="p-6">라이브러리를 여는 중...</p>
  return <DiscoveryContent key={libraryId} libraryId={libraryId} />
}

function DiscoveryContent({ libraryId }: { libraryId: string }) {
  const client = useQueryClient()
  const [input, setInput] = useState('')
  const [text, setText] = useState('')
  const [page, setPage] = useState(1)
  const [tagInput, setTagInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const result = useQuery({
    queryKey: ['discovery', libraryId, text, page],
    queryFn: async () => {
      const value = await window.api.discovery.query(libraryId, { text, page })
      if (!value.ok) throw new Error(value.error)
      return value.value
    },
    // Detail edits, metadata imports and removals happen on other routes.
    staleTime: 0,
    retry: false,
  })
  const savedTags = result.data?.preferences.preferredTags.join(', ')
  useEffect(() => {
    if (savedTags !== undefined) setTagInput(savedTags)
  }, [savedTags])
  async function change(action: () => Promise<Result<DiscoveryPreferences, string>>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      const value = await action()
      if (!value.ok) throw new Error(value.error)
      setNotice('선호 정보를 저장했습니다.')
      await client.invalidateQueries({ queryKey: ['discovery', libraryId] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="w-full overflow-y-auto p-4 sm:p-6" aria-label="추천 탐색">
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold">내 라이브러리 추천 탐색</h1>
          <p className="mt-2 text-sm text-zinc-400">
            현재 라이브러리의 즐겨찾기, 높은 별점, 시청 이력과 공통 태그를 이용합니다. 등록한 인물
            이름도 태그로 비교합니다. 검색어와 이력은 외부로 전송하지 않습니다.
          </p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            setText(input)
            setPage(1)
          }}
          className="flex flex-wrap gap-2"
        >
          <label className="min-w-48 flex-1">
            영상 조건
            <input
              value={input}
              maxLength={300}
              onChange={(event) => setInput(event.target.value)}
              placeholder="아직 안 본 20분 이하 축구"
              className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-900 p-2"
            />
          </label>
          <button className="self-end rounded bg-indigo-700 px-4 py-2">조건으로 찾기</button>
        </form>
        <details className="text-sm text-zinc-400">
          <summary className="cursor-pointer">입력할 수 있는 조건과 추천 기준</summary>
          <p className="mt-2">
            미시청 / 아직 안 본, 즐겨찾기, 자막 있는, 최근 본, 20분 이하·미만·이상·초과, 별점 4점
            이상을 조합할 수 있습니다. 나머지 단어는 제목·파일명·메모·태그에 모두 포함된 영상을
            찾습니다. 자유로운 문장 전체를 이해하는 AI 검색은 아닙니다.
          </p>
          <p className="mt-2">
            선호 태그를 우선하고 즐겨찾기·4점 이상 평가·시청한 영상의 공통 태그를 더합니다. 추천
            이유를 각 항목에 표시하며, 근거가 없으면 파일명 순으로 표시합니다. 외부 콘텐츠 추천과
            인물 자동 인식은 지원하지 않습니다.
          </p>
        </details>
        <div className="rounded border border-zinc-700 p-3">
          <label className="block text-sm">
            선호 태그·인물 (쉼표로 구분)
            <input
              value={tagInput}
              disabled={busy}
              onChange={(event) => setTagInput(event.target.value)}
              className="mt-1 w-full rounded bg-zinc-800 p-2"
              placeholder="축구, 선수 이름"
            />
          </label>
          <button
            disabled={busy || !result.data}
            onClick={() =>
              void change(() =>
                window.api.discovery.tags(
                  libraryId,
                  tagInput
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              )
            }
            className="mt-2 rounded bg-zinc-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            선호 태그 저장
          </button>
          <button
            disabled={busy || !result.data}
            onClick={() => {
              setTagInput('')
              void change(() => window.api.discovery.tags(libraryId, []))
            }}
            className="ml-2 rounded px-3 py-2 text-sm disabled:opacity-50"
          >
            선호 태그 지우기
          </button>
        </div>
        {notice && (
          <p role="status" className="text-sm text-emerald-300">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {result.isPending && <p role="status">라이브러리에서 찾는 중...</p>}
        {result.error && (
          <div>
            <p role="alert">{result.error.message}</p>
            <button onClick={() => void result.refetch()} className="mt-2 rounded bg-zinc-700 p-2">
              추천 다시 불러오기
            </button>
          </div>
        )}
        {result.data && (
          <>
            <p className="text-sm text-zinc-400">
              적용 조건: {result.data.conditions.join(' / ') || '전체 영상 · 추천 순'} ·{' '}
              {result.data.total}개
            </p>
            {!result.data.total && (
              <p>조건에 맞는 영상이 없습니다. 조건이나 검색어를 줄여 보세요.</p>
            )}
            {result.data.total > 0 && result.data.videos.length === 0 && (
              <button onClick={() => setPage(1)}>첫 페이지로 돌아가기</button>
            )}
            <ul className="space-y-3">
              {result.data.videos.map(({ video, favorite, reasons }) => (
                <li key={video.id} className="rounded border border-zinc-800 bg-zinc-900 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/player/${libraryId}/${video.id}`}
                        className="break-words font-semibold text-indigo-300"
                      >
                        {video.title || video.fileName}
                      </Link>
                      <p className="mt-1 break-all text-xs text-zinc-500">{video.fileName}</p>
                    </div>
                    <button
                      aria-pressed={favorite}
                      disabled={busy}
                      onClick={() =>
                        void change(() =>
                          window.api.discovery.favorite(libraryId, video.id, !favorite),
                        )
                      }
                      className="shrink-0 rounded bg-zinc-800 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {favorite ? '즐겨찾기 해제' : '즐겨찾기 등록'}
                    </button>
                  </div>
                  <p className="mt-2 break-words text-sm text-zinc-400">{reasons.join(' · ')}</p>
                </li>
              ))}
            </ul>
            <nav aria-label="추천 페이지" className="flex items-center gap-3">
              <button
                disabled={page <= 1 || result.isFetching}
                onClick={() => setPage((value) => value - 1)}
                className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-50"
              >
                이전
              </button>
              <span>
                {page} / {Math.max(1, Math.ceil(result.data.total / 50))}
              </span>
              <button
                disabled={page * 50 >= result.data.total || result.isFetching}
                onClick={() => setPage((value) => value + 1)}
                className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-50"
              >
                다음
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  )
}
