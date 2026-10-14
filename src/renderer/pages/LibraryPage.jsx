// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useLibraryStore } from '../store/libraryStore'
import { useVideos } from '../api/useVideos'
import { useLibrarySubtitleJobs } from '../api/useLibrarySubtitleJobs'
import {
  useLibraries,
  useCreateLibrary,
  useOpenLibrary,
  useDeleteLibrary,
} from '../api/useLibraries'
import { libraryApi } from '../api'
import VideoGrid from '../components/library/VideoGrid'
import DetailPanel from '../components/library/DetailPanel'
import ImportDialog, {
  useLibraryWorkProgress,
  WorkProgress,
} from '../components/library/ImportDialog'
import CsvImportDialog from '../components/library/CsvImportDialog'
function LibraryPage() {
  const {
    activeLibraryId,
    openedLibraryId,
    selectedVideoId,
    setActiveLibrary,
    setOpenedLibraryId,
    setSelectedVideoId,
    getSortPreference,
    setSortPreference,
    getSearchText,
    setSearchText,
    getWithoutSubtitles,
    setWithoutSubtitles,
    getScrollTop,
    setScrollTop,
  } = useLibraryStore()
  const navigate = useNavigate()
  const qc2 = useQueryClient()
  const { data: libraries = [] } = useLibraries()
  const createLibrary = useCreateLibrary()
  const deleteLibrary = useDeleteLibrary()
  const openLibrary = useOpenLibrary()
  const initialSort = getSortPreference(activeLibraryId)
  const initialSearchText = getSearchText(activeLibraryId)
  const initialScrollTop = getScrollTop(activeLibraryId)
  const isLibraryReady = !!activeLibraryId && openedLibraryId === activeLibraryId
  const subtitleJobs = useLibrarySubtitleJobs(activeLibraryId, isLibraryReady)
  const visibleLibraries = [...libraries].sort((a2, b2) => {
    const aTime = a2.lastOpenedAt ?? a2.createdAt
    const bTime = b2.lastOpenedAt ?? b2.createdAt
    return bTime.localeCompare(aTime)
  })
  const [query, setQuery] = React.useState({
    q: initialSearchText.trim() ? initialSearchText : void 0,
    sortBy: initialSort.sortBy,
    sortDir: initialSort.sortDir,
    page: 1,
    pageSize: 500,
    removed: false,
    hasSubtitles: getWithoutSubtitles(activeLibraryId) ? false : undefined,
  })
  const [searchInput, setSearchInput] = React.useState(initialSearchText)
  const [isComposingSearch, setIsComposingSearch] = React.useState(false)
  const [showImport, setShowImport] = React.useState(false)
  const [showCsvImport, setShowCsvImport] = React.useState(false)
  const refreshWork = useLibraryWorkProgress(activeLibraryId)
  const [refreshMessage, setRefreshMessage] = React.useState(null)
  const [refreshError, setRefreshError] = React.useState(null)
  const refreshLibrary = useMutation({
    mutationFn: async () => {
      if (!activeLibraryId) throw new Error('Library is not selected')
      const res = await libraryApi.refresh(activeLibraryId)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: (result) => {
      setRefreshMessage(
        result.cancelled
          ? '목록 업데이트가 취소되었습니다. 처리된 항목은 반영되었습니다.'
          : '목록 업데이트가 완료되었습니다.',
      )
      if (!activeLibraryId) return
      qc2.invalidateQueries({
        queryKey: ['videos', activeLibraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['video', activeLibraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['thumbnails', activeLibraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['highlights', activeLibraryId],
      })
    },
    onError: (error) =>
      setRefreshError(error instanceof Error ? error.message : '목록 업데이트에 실패했습니다.'),
    onSettled: () => refreshWork.finish(),
  })
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useVideos(
    activeLibraryId ?? '',
    query,
    isLibraryReady,
  )
  const { data: selectedVideo } = useQuery({
    queryKey: ['video', activeLibraryId, selectedVideoId],
    queryFn: async () => {
      if (!activeLibraryId || !selectedVideoId) return null
      const res = await window.api.videos.get(activeLibraryId, selectedVideoId)
      return res.ok ? res.value : null
    },
    enabled: isLibraryReady && !!selectedVideoId,
  })
  React.useEffect(() => {
    const sort = getSortPreference(activeLibraryId)
    const savedSearchText = getSearchText(activeLibraryId)
    setSearchInput(savedSearchText)
    setQuery((prev) => ({
      ...prev,
      q: savedSearchText.trim() ? savedSearchText : void 0,
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
      page: 1,
      removed: false,
      hasSubtitles: getWithoutSubtitles(activeLibraryId) ? false : undefined,
    }))
  }, [activeLibraryId, getSearchText, getSortPreference, getWithoutSubtitles])
  React.useEffect(() => {
    if (!activeLibraryId) return
    setSortPreference(activeLibraryId, {
      sortBy: query.sortBy ?? 'createdAt',
      sortDir: query.sortDir ?? 'desc',
    })
  }, [activeLibraryId, query.sortBy, query.sortDir, setSortPreference])
  React.useEffect(() => {
    return window.api.on.thumbnailReady(({ videoId }) => {
      if (!activeLibraryId) return
      qc2.invalidateQueries({
        queryKey: ['thumbnails', activeLibraryId, videoId],
      })
      qc2.invalidateQueries({
        queryKey: ['video', activeLibraryId, videoId],
      })
      qc2.invalidateQueries({
        queryKey: ['videos', activeLibraryId],
      })
    })
  }, [activeLibraryId, qc2])
  React.useEffect(() => {
    return window.api.on.highlightChanged(({ videoId }) => {
      if (!activeLibraryId) return
      qc2.invalidateQueries({
        queryKey: ['highlights', activeLibraryId, videoId],
      })
      qc2.invalidateQueries({
        queryKey: ['video', activeLibraryId, videoId],
      })
    })
  }, [activeLibraryId, qc2])
  React.useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== 'Escape') return
      if (refreshLibrary.isPending) return
      if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]'))
        return
      if (!activeLibraryId) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return
      }
      void window.api.app
        .quit()
        .then((result) => {
          if (!result.ok) throw new Error(result.error)
        })
        .catch((error) =>
          window.alert(
            `앱을 종료하지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`,
          ),
        )
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeLibraryId, refreshLibrary.isPending])
  React.useEffect(() => {
    if (isComposingSearch) return
    const timer = setTimeout(() => {
      setQuery((prev) => ({
        ...prev,
        q: searchInput.trim() ? searchInput : void 0,
        page: 1,
      }))
    }, 350)
    return () => clearTimeout(timer)
  }, [activeLibraryId, isComposingSearch, searchInput])
  function handleVideoClick(video) {
    setSelectedVideoId(video.id)
  }
  function handleRefreshLibrary() {
    if (refreshLibrary.isPending) return
    setRefreshMessage(null)
    setRefreshError(null)
    refreshWork.begin('scanning')
    refreshLibrary.mutate()
  }
  function handleVideoDoubleClick(video) {
    if (query.removed || video.removalMode) {
      setSelectedVideoId(video.id)
      return
    }
    navigate(`/player/${activeLibraryId}/${video.id}`)
  }
  function toggleRemovedItems() {
    setSelectedVideoId(null)
    setSearchInput('')
    setIsComposingSearch(false)
    if (activeLibraryId) {
      setSearchText(activeLibraryId, '')
      setScrollTop(activeLibraryId, 0)
    }
    setQuery((prev) => ({ ...prev, removed: !prev.removed, q: undefined, page: 1 }))
  }
  function handleWithoutSubtitlesChange(event) {
    const checked = event.target.checked
    setSelectedVideoId(null)
    if (activeLibraryId) {
      setWithoutSubtitles(activeLibraryId, checked)
      setScrollTop(activeLibraryId, 0)
    }
    setQuery((prev) => ({ ...prev, hasSubtitles: checked ? false : undefined, page: 1 }))
  }
  async function handleCreateLibrary() {
    try {
      const folderRes = await libraryApi.selectFolder()
      if (!folderRes.ok) throw new Error(folderRes.error)
      if (!folderRes.value) return
      const folder = folderRes.value
      const name = folder.split(/[\\/]/).pop() ?? '새 라이브러리'
      createLibrary.mutate(
        {
          name,
          folderPath: folder,
        },
        {
          onSuccess: (library) => {
            setActiveLibrary(library)
            setOpenedLibraryId(library.id)
            setSelectedVideoId(null)
            navigate('/')
          },
          onError: (error) => {
            window.alert(`라이브러리 생성에 실패했습니다.
${error.message}`)
          },
        },
      )
    } catch (error) {
      window.alert(
        `라이브러리 폴더를 선택하지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  function handleOpenLibrary(libraryId) {
    openLibrary.mutate(libraryId, {
      onSuccess: (library) => {
        setActiveLibrary(library)
        setOpenedLibraryId(library.id)
        setSelectedVideoId(null)
        navigate('/')
      },
      onError: (error) => {
        window.alert(`라이브러리를 열지 못했습니다.
${error.message}`)
      },
    })
  }
  function handleDeleteLibrary(library) {
    const confirmed = window.confirm(`목록에서 "${library.name}" 라이브러리를 삭제할까요?`)
    if (!confirmed) return
    deleteLibrary.mutate(library.id, {
      onSuccess: () => {
        if (library.id !== activeLibraryId) return
        setActiveLibrary(null)
        setOpenedLibraryId(null)
        setSelectedVideoId(null)
      },
      onError: (error) =>
        window.alert(
          `라이브러리를 삭제하지 못했습니다.\n${error instanceof Error ? error.message : String(error)}`,
        ),
    })
  }
  function handleSearchChange(event) {
    const nextValue = event.target.value
    setSearchInput(nextValue)
    // Persist input immediately; navigating before the query debounce must not discard it.
    if (activeLibraryId) setSearchText(activeLibraryId, nextValue)
  }
  function handleSearchCompositionStart(_event) {
    setIsComposingSearch(true)
  }
  function handleSearchCompositionEnd(event) {
    const nextValue = event.currentTarget.value
    setIsComposingSearch(false)
    setSearchInput(nextValue)
    if (activeLibraryId) {
      setSearchText(activeLibraryId, nextValue)
    }
    setQuery((prev) => ({
      ...prev,
      q: nextValue.trim() ? nextValue : void 0,
      page: 1,
    }))
  }
  if (!activeLibraryId) {
    return (
      <div className={'flex flex-1 items-center justify-center bg-zinc-950 p-8'}>
        <div
          className={
            'w-full max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl'
          }
        >
          <div className={'mb-6 flex items-center justify-between gap-4'}>
            <div>
              <h2 className={'text-xl font-semibold text-zinc-100'}>{'라이브러리 선택'}</h2>
              <p className={'mt-1 text-sm text-zinc-500'}>
                {'앱을 처음 실행했거나 현재 선택된 라이브러리가 없을 때만 이 화면이 표시됩니다.'}
              </p>
            </div>
            <button
              onClick={() => void handleCreateLibrary()}
              className={
                'rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500'
              }
            >
              {'새 라이브러리'}
            </button>
          </div>
          {libraries.length === 0 ? (
            <div
              className={
                'rounded-xl border border-dashed border-zinc-700 bg-zinc-950/50 px-6 py-12 text-center text-zinc-500'
              }
            >
              {'아직 라이브러리가 없습니다. 새 라이브러리를 만들어 시작해보세요.'}
            </div>
          ) : (
            <div className={'grid gap-3 md:grid-cols-2'}>
              {visibleLibraries.map((library) => (
                <div
                  className={'rounded-xl border border-zinc-800 bg-zinc-950/60 p-4'}
                  key={library.id}
                >
                  <p className={'truncate text-sm font-semibold text-zinc-100'}>{library.name}</p>
                  <p className={'mt-1 truncate font-mono text-[11px] text-zinc-600'}>
                    {library.id}
                  </p>
                  <p className={'mt-1 truncate text-xs text-zinc-500'}>{library.folderPath}</p>
                  <p className={'mt-2 text-[11px] text-zinc-600'}>
                    {'마지막 열기:'}{' '}
                    {library.lastOpenedAt
                      ? new Date(library.lastOpenedAt).toLocaleString()
                      : '없음'}
                  </p>
                  <div className={'mt-4 flex items-center gap-2'}>
                    <button
                      onClick={() => handleOpenLibrary(library.id)}
                      className={
                        'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700'
                      }
                    >
                      {'열기'}
                    </button>
                    <button
                      onClick={() => handleDeleteLibrary(library)}
                      className={
                        'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-red-300'
                      }
                    >
                      {'삭제'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }
  if (!isLibraryReady) {
    return (
      <div className={'flex flex-1 items-center justify-center text-zinc-500'}>
        <p>{'라이브러리를 여는 중입니다...'}</p>
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className={'flex flex-1 items-center justify-center text-zinc-500'}>
        <p>{'영상 목록을 불러오는 중입니다...'}</p>
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className={'flex flex-1 items-center justify-center text-red-400'}>
        <p>{'영상 라이브러리를 불러오지 못했습니다.'}</p>
      </div>
    )
  }
  return (
    <div className={'flex flex-1 overflow-hidden'}>
      <div className={'flex flex-1 flex-col overflow-hidden'}>
        <div className={'flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3'}>
          <input
            type={'text'}
            placeholder={'영상 검색...'}
            className={
              'min-w-40 flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-hidden focus:ring-1 focus:ring-zinc-600'
            }
            value={searchInput}
            onChange={handleSearchChange}
            onCompositionStart={handleSearchCompositionStart}
            onCompositionEnd={handleSearchCompositionEnd}
          />
          <select
            value={query.sortBy ?? 'createdAt'}
            onChange={(event) =>
              setQuery((prev) => ({
                ...prev,
                sortBy: event.target.value,
                page: 1,
              }))
            }
            className={
              'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 outline-hidden focus:ring-1 focus:ring-zinc-600'
            }
          >
            <option value={'rating'}>{'별점순'}</option>
            <option value={'title'}>{'제목순'}</option>
            <option value={'createdAt'}>{'추가된 순'}</option>
            <option value={'playCount'}>{'많이 시청한 순'}</option>
          </select>
          <select
            value={query.sortDir ?? 'desc'}
            onChange={(event) =>
              setQuery((prev) => ({
                ...prev,
                sortDir: event.target.value,
                page: 1,
              }))
            }
            className={
              'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 outline-hidden focus:ring-1 focus:ring-zinc-600'
            }
          >
            <option value={'asc'}>{'오름차순'}</option>
            <option value={'desc'}>{'내림차순'}</option>
          </select>
          <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700">
            <input
              type="checkbox"
              checked={query.hasSubtitles === false}
              onChange={handleWithoutSubtitlesChange}
              className="h-3.5 w-3.5 accent-indigo-500"
            />
            자막 없는 영상만
          </label>
          <span className={'text-xs text-zinc-500'}>
            {data.total}
            {'개 영상'}
          </span>
          <button
            type="button"
            onClick={toggleRemovedItems}
            aria-pressed={Boolean(query.removed)}
            className={`rounded border px-3 py-1.5 text-xs ${query.removed ? 'border-amber-700 bg-amber-950/40 text-amber-200' : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
          >
            제거한 항목
          </button>
          <button
            onClick={handleRefreshLibrary}
            disabled={refreshLibrary.isPending}
            className={
              'rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-600 disabled:opacity-50'
            }
          >
            {refreshLibrary.isPending ? '목록 갱신 중...' : '목록 업데이트'}
          </button>
          <button
            onClick={() => setShowImport(true)}
            disabled={refreshLibrary.isPending}
            className={'rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-600'}
          >
            {'폴더 가져오기'}
          </button>
          <button
            onClick={() => setShowCsvImport(true)}
            disabled={refreshLibrary.isPending}
            className={'rounded bg-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-600'}
          >
            {'CSV 가져오기'}
          </button>
        </div>
        {refreshWork.progress && (
          <div className="px-4">
            <WorkProgress work={refreshWork} isWorking={refreshLibrary.isPending} />
          </div>
        )}
        {refreshMessage && (
          <p role="status" className="px-4 py-2 text-xs text-indigo-200">
            {refreshMessage}
          </p>
        )}
        {refreshError && (
          <p role="alert" className="px-4 py-2 text-xs text-red-300">
            {refreshError}
          </p>
        )}
        {query.removed && (
          <p role="status" className="border-b border-zinc-800 px-4 py-2 text-xs text-amber-200">
            제거한 항목입니다. 영상을 선택하여 원본 위치를 확인하고 목록을 복구할 수 있습니다.
          </p>
        )}
        {subtitleJobs.error && (
          <div role="alert" className="flex items-center gap-3 px-4 py-2 text-xs text-amber-200">
            <span>자막 진행 상태를 갱신하지 못했습니다.</span>
            <button
              type="button"
              onClick={() => void subtitleJobs.refetch()}
              disabled={subtitleJobs.isFetching}
              className="underline disabled:opacity-50"
            >
              다시 확인
            </button>
          </div>
        )}
        <VideoGrid
          key={`${activeLibraryId}-${Boolean(query.removed)}-${query.hasSubtitles === false}`}
          videos={data.videos.filter(
            (video) =>
              Boolean(video.removalMode) === Boolean(query.removed) &&
              (query.hasSubtitles !== false || !video.hasSubtitles),
          )}
          selectedVideoId={selectedVideoId}
          subtitleJobs={subtitleJobs.jobsByVideo}
          initialScrollTop={initialScrollTop}
          onScrollTopChange={(value) => setScrollTop(activeLibraryId, value)}
          onVideoClick={handleVideoClick}
          onVideoDoubleClick={handleVideoDoubleClick}
        />
        {hasNextPage && (
          <button
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-indigo-300 disabled:opacity-50"
          >
            {isFetchingNextPage
              ? '불러오는 중...'
              : `더 불러오기 (${data.videos.length} / ${data.total})`}
          </button>
        )}
      </div>
      <aside className={'w-80 shrink-0 border-l border-zinc-800 bg-zinc-900'}>
        {selectedVideo ? (
          <DetailPanel
            key={selectedVideo.id}
            video={selectedVideo}
            libraryId={activeLibraryId}
            onClose={() => setSelectedVideoId(null)}
            onVideoDeleted={() => setSelectedVideoId(null)}
            onVideoRestored={() => setSelectedVideoId(null)}
            showCloseButton={false}
          />
        ) : (
          <div
            className={
              'flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500'
            }
          >
            {'영상을 선택하면 오른쪽에 상세 정보가 표시됩니다.'}
          </div>
        )}
      </aside>
      {showImport && (
        <ImportDialog libraryId={activeLibraryId} onClose={() => setShowImport(false)} />
      )}
      {showCsvImport && (
        <CsvImportDialog libraryId={activeLibraryId} onClose={() => setShowCsvImport(false)} />
      )}
    </div>
  )
}
export default LibraryPage
