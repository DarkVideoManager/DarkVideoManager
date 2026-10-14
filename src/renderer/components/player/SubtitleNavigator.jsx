import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

function formatCueTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const secs = Math.floor((totalMs % 60000) / 1000)
  const millis = String(totalMs % 1000).padStart(3, '0')
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(secs).padStart(2, '0')}.${millis}`
}

export default function SubtitleNavigator({
  cues,
  tracks,
  selectedTrackId,
  onSelectTrack,
  currentTimeSec,
  isLoading,
  error,
  onSeek,
  getTrackLabel,
}) {
  const [search, setSearch] = React.useState('')
  const scrollRef = React.useRef(null)
  const query = search.trim().toLocaleLowerCase()
  const results = React.useMemo(
    () =>
      cues
        .map((cue, index) => ({ cue, index }))
        .filter(({ cue }) => !query || cue.text.toLocaleLowerCase().includes(query)),
    [cues, query],
  )
  const activeIndex = Number.isFinite(currentTimeSec)
    ? cues.findIndex((cue) => currentTimeSec >= cue.startSec && currentTimeSec < cue.endSec)
    : -1
  const currentResultIndex = results.findIndex(({ index }) => index === activeIndex)
  const getItemKey = React.useCallback(
    (index) => `${selectedTrackId}:${results[index].index}`,
    [results, selectedTrackId],
  )
  const virtualizer = useVirtualizer({
    count: results.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    getItemKey,
    overscan: 5,
  })
  React.useEffect(() => {
    setSearch('')
  }, [selectedTrackId])
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [query, selectedTrackId])

  return (
    <section aria-label="자막 탐색" className="flex h-full min-h-0 flex-col text-zinc-100">
      <div className="shrink-0 space-y-3 border-b border-zinc-800 p-3">
        <p className="text-xs text-zinc-400">자막을 클릭하면 해당 시간으로 이동합니다.</p>
        {tracks.length > 1 && (
          <label className="block space-y-1 text-xs text-zinc-400">
            <span>탐색할 자막</span>
            <select
              aria-label="탐색할 자막"
              value={selectedTrackId ?? ''}
              onChange={(event) => onSelectTrack(event.target.value)}
              className="block w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-2 text-zinc-100"
            >
              {tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {getTrackLabel(track)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex gap-2">
          <input
            type="search"
            aria-label="자막 검색"
            placeholder="자막 내용 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm placeholder:text-zinc-500"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="text-xs text-zinc-400 hover:text-white"
            >
              검색 지우기
            </button>
          )}
        </div>
        <div className="flex items-center justify-between text-xs">
          <span role="status" className="text-zinc-400">
            {isLoading
              ? '자막을 불러오는 중...'
              : `${query ? '검색 결과' : '전체'} ${results.length}개`}
          </span>
          <button
            type="button"
            disabled={currentResultIndex < 0 || isLoading || Boolean(error)}
            onClick={() => virtualizer.scrollToIndex(currentResultIndex, { align: 'center' })}
            className="rounded px-2 py-1 text-indigo-300 hover:bg-zinc-800 disabled:text-zinc-600"
          >
            현재 자막
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="p-4 text-sm text-red-300">
          {error}
        </p>
      ) : !isLoading && results.length === 0 ? (
        <p className="p-4 text-sm text-zinc-400">
          {query
            ? '검색 결과가 없습니다.'
            : tracks.length === 0
              ? '등록된 자막이 없습니다.'
              : '탐색할 자막 문장이 없습니다.'}
        </p>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <ul
            aria-label="자막 목록"
            className="relative"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const { cue, index } = results[row.index]
              const isActive = index === activeIndex
              return (
                <li
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  aria-posinset={row.index + 1}
                  aria-setsize={results.length}
                  className="absolute left-0 top-0 w-full px-2 pb-1"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <button
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => void onSeek(cue.startSec)}
                    className={`w-full rounded border px-3 py-3 text-left ${isActive ? 'border-indigo-500/60 bg-indigo-500/15' : 'border-transparent hover:bg-zinc-800'}`}
                  >
                    <span className="mb-1 block text-xs tabular-nums text-indigo-300">
                      {formatCueTime(cue.startSec)}
                    </span>
                    <span className="block whitespace-pre-line break-words text-sm leading-relaxed">
                      {cue.text}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
