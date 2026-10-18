// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useLibraryStore } from '../store/libraryStore'
import { useVideos } from '../api/useVideos'
import { useLibrarySubtitleJobs } from '../api/useLibrarySubtitleJobs'
import { useThumbnailJobs } from '../api/useThumbnailJobs'
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
import VideoMetadataFilters from '../components/library/VideoMetadataFilters'
import { requestPrivacyExit } from '../components/privacy/PrivacyBoundary'
import { folderLabel } from '../components/library/folderLabel'
function LibraryPage() {
  const {
    activeLibraryId,
    openedLibraryId,
    selectedVideoId,
    activateLibrary,
    libraryTransitionPending,
    setSelectedVideoId,
    getSortPreference,
    setSortPreference,
    getSearchText,
    setSearchText,
    getWithoutSubtitles,
    setWithoutSubtitles,
    getMetadataFilters,
    setMetadataFilters,
    getScrollTop,
    setScrollTop,
  } = useLibraryStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const showManagement = !activeLibraryId || searchParams.get('manage') === '1'
  const qc2 = useQueryClient()
  const { data: libraries = [] } = useLibraries()
  const createLibrary = useCreateLibrary()
  const deleteLibrary = useDeleteLibrary()
  const openLibrary = useOpenLibrary()
  const initialSort = getSortPreference(activeLibraryId)
  const initialSearchText = getSearchText(activeLibraryId)
  const initialScrollTop = getScrollTop(activeLibraryId)
  const [queryLibraryId, setQueryLibraryId] = React.useState(activeLibraryId)
  const isLibraryReady =
    !!activeLibraryId && openedLibraryId === activeLibraryId && queryLibraryId === activeLibraryId
  const subtitleJobs = useLibrarySubtitleJobs(activeLibraryId, isLibraryReady)
  const thumbnailJobs = useThumbnailJobs(activeLibraryId, isLibraryReady)
  const visibleLibraries = [...libraries].sort((a2, b2) => {
    const aTime = a2.lastOpenedAt ?? a2.createdAt
    const bTime = b2.lastOpenedAt ?? b2.createdAt
    return bTime.localeCompare(aTime)
  })
  const [query, setQuery] = React.useState({
    ...getMetadataFilters(activeLibraryId),
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
  const [refreshResult, setRefreshResult] = React.useState(null)
  const activeLibraryRef = React.useRef(activeLibraryId)
  activeLibraryRef.current = activeLibraryId
  React.useEffect(() => {
    setRefreshMessage(null)
    setRefreshError(null)
    setRefreshResult(null)
  }, [activeLibraryId])
  const refreshLibrary = useMutation({
    mutationFn: async (libraryId) => {
      if (!libraryId) throw new Error('Library is not selected')
      const res = await libraryApi.refresh(libraryId)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: (result, libraryId) => {
      if (activeLibraryRef.current === libraryId) {
        setRefreshResult(result)
        setRefreshMessage(
          result.cancelled
            ? '목록 업데이트가 취소되었습니다. 처리된 항목은 반영되었습니다.'
            : result.errors.length
              ? '목록 업데이트 결과를 확인해 주세요. 일부 항목을 처리하지 못했습니다.'
              : '목록 업데이트가 완료되었습니다.',
        )
      }
      qc2.invalidateQueries({
        queryKey: ['videos', libraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['video', libraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['thumbnails', libraryId],
      })
      qc2.invalidateQueries({
        queryKey: ['highlights', libraryId],
      })
      qc2.invalidateQueries({ queryKey: ['video-metadata-options', libraryId] })
    },
    onError: (error, libraryId) => {
      if (activeLibraryRef.current === libraryId)
        setRefreshError(error instanceof Error ? error.message : '목록 업데이트에 실패했습니다.')
    },
    onSettled: (_data, _error, libraryId) => refreshWork.finish(libraryId),
  })
  const isRefreshingCurrent =
    refreshLibrary.isPending && refreshLibrary.variables === activeLibraryId
  const {
    data,
    isLoading,
    isError,
    isPlaceholderData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useVideos(activeLibraryId ?? '', query, isLibraryReady)
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
    setQueryLibraryId(activeLibraryId)
    const savedSearchText = getSearchText(activeLibraryId)
    setSearchInput(savedSearchText)
    setQuery((prev) => ({
      ...prev,
      q: savedSearchText.trim() ? savedSearchText : void 0,
      category: getMetadataFilters(activeLibraryId).category,
      tag: getMetadataFilters(activeLibraryId).tag,
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
      page: 1,
      removed: false,
      hasSubtitles: getWithoutSubtitles(activeLibraryId) ? false : undefined,
    }))
  }, [activeLibraryId, getSearchText, getSortPreference, getWithoutSubtitles, getMetadataFilters])
  React.useEffect(() => {
    if (!activeLibraryId || queryLibraryId !== activeLibraryId) return
    setSortPreference(activeLibraryId, {
      sortBy: query.sortBy ?? 'createdAt',
      sortDir: query.sortDir ?? 'desc',
    })
  }, [activeLibraryId, queryLibraryId, query.sortBy, query.sortDir, setSortPreference])
  React.useEffect(() => {
    let thumbnailsStarted = false
    return window.api.on.importProgress((progress) => {
      if (!activeLibraryId || (progress.libraryId && progress.libraryId !== activeLibraryId)) return
      if (progress.phase === 'thumbnails' && !thumbnailsStarted) {
        void qc2.invalidateQueries({ queryKey: ['videos', activeLibraryId] })
        void qc2.invalidateQueries({ queryKey: ['thumbnail-jobs', activeLibraryId] })
      }
      thumbnailsStarted = progress.phase === 'thumbnails'
      if (progress.phase === 'done') {
        void qc2.invalidateQueries({ queryKey: ['video-metadata-options', activeLibraryId] })
      }
    })
  }, [activeLibraryId, qc2])
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
      event.preventDefault()
      requestPrivacyExit()
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
    setRefreshResult(null)
    refreshWork.begin('scanning')
    refreshLibrary.mutate(activeLibraryId)
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
  function handleMetadataFiltersChange(patch) {
    const filters = { category: query.category, tag: query.tag, ...patch }
    setSelectedVideoId(null)
    if (activeLibraryId) {
      setMetadataFilters(activeLibraryId, filters)
      setScrollTop(activeLibraryId, 0)
    }
    setQuery((prev) => ({ ...prev, ...filters, page: 1 }))
  }
  async function handleCreateLibrary() {
    try {
      if (libraryTransitionPending) return
      const folderRes = await libraryApi.selectFolders()
      if (!folderRes.ok) throw new Error(folderRes.error)
      if (!folderRes.value) return
      const folders = folderRes.value
      if (!folders.length) return
      const name =
        folderLabel(folders[0]) + (folders.length > 1 ? ` 외 ${folders.length - 1}개 폴더` : '')
      createLibrary.mutate(
        {
          name,
          folderPath: folders,
        },
        {
          onSuccess: () => {
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
    if (libraryTransitionPending) return
    openLibrary.mutate(libraryId, {
      onSuccess: () => {
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
        if (library.id !== useLibraryStore.getState().activeLibraryId) return
        activateLibrary(null)
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
  if (showManagement) {
    return (
      <div
        className={'flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-zinc-950 p-8'}
      >
        <div
          className={
            'w-full max-w-4xl rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl'
          }
        >
          <div
            className={
              'mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center'
            }
          >
            <div className="min-w-0 flex-1">
              <h2 className={'text-xl font-semibold text-zinc-100'}>{'라이브러리 선택'}</h2>
              <p className={'mt-1 text-sm text-zinc-500'}>
                {
                  '폴더 여러 개나 드라이브 전체를 한 라이브러리로 등록할 수 있습니다. 다른 라이브러리도 재실행 없이 열 수 있습니다.'
                }
              </p>
            </div>
            <button
              onClick={() => void handleCreateLibrary()}
              disabled={libraryTransitionPending}
              className={
                'shrink-0 whitespace-nowrap rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50'
              }
            >
              {'새 라이브러리'}
            </button>
          </div>
          {activeLibraryId && (
            <button onClick={() => navigate('/')} className="mb-4 text-sm text-indigo-300">
              현재 라이브러리로 돌아가기
            </button>
          )}
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
                  <ul
                    aria-label={`${library.name} 등록 폴더`}
                    className="mt-1 text-xs text-zinc-500"
                  >
                    {(library.folderPaths?.length ? library.folderPaths : [library.folderPath]).map(
                      (folder) => (
                        <li key={folder} className="break-all">
                          {folder}
                        </li>
                      ),
                    )}
                  </ul>
                  <p className={'mt-2 text-[11px] text-zinc-600'}>
                    {'마지막 열기:'}{' '}
                    {library.lastOpenedAt
                      ? new Date(library.lastOpenedAt).toLocaleString()
                      : '없음'}
                  </p>
                  <div className={'mt-4 flex items-center gap-2'}>
                    <button
                      onClick={() => handleOpenLibrary(library.id)}
                      disabled={libraryTransitionPending}
                      className={
                        'rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700'
                      }
                    >
                      {'열기'}
                    </button>
                    <button
                      onClick={() => handleDeleteLibrary(library)}
                      disabled={libraryTransitionPending || deleteLibrary.isPending}
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
    <div className={'flex min-h-0 min-w-0 flex-1 overflow-hidden'}>
      <div className={'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'}>
        <div
          className={
            'flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3'
          }
        >
          <input
            type={'text'}
            placeholder={'영상 검색...'}
            aria-label="영상 검색"
            title="제목·파일명·태그 검색. #선수명으로 태그만 검색할 수 있습니다."
            className={
              'min-w-40 flex-1 rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-hidden focus:ring-1 focus:ring-zinc-600'
            }
            value={searchInput}
            onChange={handleSearchChange}
            onCompositionStart={handleSearchCompositionStart}
            onCompositionEnd={handleSearchCompositionEnd}
          />
          <select
            aria-label="영상 정렬 기준"
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
            aria-label="영상 정렬 방향"
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
            {isPlaceholderData ? '검색 중...' : `${data.total}개 영상`}
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
            {isRefreshingCurrent ? '목록 갱신 중...' : '목록 업데이트'}
          </button>
          <button
            onClick={() => setShowImport('files')}
            disabled={refreshLibrary.isPending}
            className={'rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500'}
          >
            영상 파일 추가
          </button>
          <button
            onClick={() => setShowImport('folder')}
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
        <VideoMetadataFilters
          libraryId={activeLibraryId}
          query={query}
          onChange={handleMetadataFiltersChange}
        />
        {refreshLibrary.isPending && !isRefreshingCurrent && (
          <p role="status" className="px-4 py-2 text-xs text-zinc-400">
            다른 라이브러리의 목록 업데이트가 진행 중입니다. 해당 라이브러리로 전환하면 진행 상태를
            확인하거나 취소할 수 있습니다.
          </p>
        )}
        <details className="border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400">
          <summary className="w-fit cursor-pointer text-zinc-300">영상 추가·폴더 갱신 안내</summary>
          <div className="mt-2 space-y-1 leading-relaxed">
            <p>영상 한 개만 추가하려면 영상 파일 추가를 누르세요. 선택한 파일만 처리합니다.</p>
            <p>
              폴더 가져오기는 폴더와 하위 폴더를 갱신 대상으로 등록합니다. 새 파일이 생기면 목록
              업데이트를 눌러 수동 반영하세요. 폴더 자동 감시는 지원하지 않습니다.
            </p>
            <p>
              목록 업데이트는 등록 폴더를 검색하여 새 영상을 추가하고 사라진 영상을 제거한 항목으로
              옮깁니다. 기존 영상의 정보와 썸네일은 다시 만들지 않습니다. 썸네일이 없는 영상은
              생성을 다시 시도합니다.
            </p>
            <p>
              파일 추가로만 등록한 영상의 폴더는 갱신 대상으로 추가되지 않습니다. 진행 단계와 완료
              후 추가·기존·제거·오류 수를 아래에서 확인할 수 있습니다.
            </p>
          </div>
        </details>
        {refreshWork.progress && (
          <div className="px-4">
            <WorkProgress work={refreshWork} isWorking={isRefreshingCurrent} />
          </div>
        )}
        {refreshMessage && (
          <p role="status" className="px-4 py-2 text-xs text-indigo-200">
            {refreshMessage}
          </p>
        )}
        {refreshResult && (
          <p className="px-4 pb-2 text-xs text-zinc-400">
            추가 {refreshResult.added}개 · 기존 {refreshResult.skipped}개 · 제거{' '}
            {refreshResult.removed}개 · 오류 {refreshResult.errors.length}개
          </p>
        )}
        {refreshResult?.errors.length > 0 && (
          <ul
            role="alert"
            className="max-h-32 overflow-y-auto break-words px-4 pb-2 text-xs text-amber-300"
          >
            {refreshResult.errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
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
        {thumbnailJobs.error && (
          <div role="alert" className="flex items-center gap-3 px-4 py-2 text-xs text-amber-200">
            <span>썸네일 진행 상태를 갱신하지 못했습니다.</span>
            <button
              type="button"
              onClick={() => void thumbnailJobs.refetch()}
              disabled={thumbnailJobs.isFetching}
              className="underline disabled:opacity-50"
            >
              다시 확인
            </button>
          </div>
        )}
        {isPlaceholderData ? (
          <div
            role="status"
            className="flex min-h-0 flex-1 items-center justify-center text-sm text-zinc-500"
          >
            조건에 맞는 영상을 찾고 있습니다...
          </div>
        ) : (
          <VideoGrid
            key={JSON.stringify([
              activeLibraryId,
              Boolean(query.removed),
              query.hasSubtitles === false,
              query.category,
              query.tag,
            ])}
            videos={data.videos.filter(
              (video) =>
                Boolean(video.removalMode) === Boolean(query.removed) &&
                (query.hasSubtitles !== false || !video.hasSubtitles),
            )}
            selectedVideoId={selectedVideoId}
            subtitleJobs={subtitleJobs.jobsByVideo}
            thumbnailJobs={thumbnailJobs}
            initialScrollTop={initialScrollTop}
            onScrollTopChange={(value) => setScrollTop(activeLibraryId, value)}
            onVideoClick={handleVideoClick}
            onVideoDoubleClick={handleVideoDoubleClick}
          />
        )}
        {!isPlaceholderData && hasNextPage && (
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
            thumbnailJobs={thumbnailJobs}
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
        <ImportDialog
          libraryId={activeLibraryId}
          thumbnailJobs={thumbnailJobs}
          mode={showImport}
          onClose={() => setShowImport(false)}
        />
      )}
      {showCsvImport && (
        <CsvImportDialog libraryId={activeLibraryId} onClose={() => setShowCsvImport(false)} />
      )}
    </div>
  )
}
export default LibraryPage
