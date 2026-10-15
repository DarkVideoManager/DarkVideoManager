// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import ThumbnailJobStatus, { isThumbnailJobActive } from './ThumbnailJobStatus'

export function useLibraryWorkProgress(libraryId) {
  const [progress, setProgress] = React.useState(null)
  const [isCancelling, setIsCancelling] = React.useState(false)
  const [cancelError, setCancelError] = React.useState(null)
  const activeRef = React.useRef(false)
  React.useEffect(
    () =>
      window.api.on.importProgress((next) => {
        if (!activeRef.current || (next.libraryId && next.libraryId !== libraryId)) return
        setProgress(next)
      }),
    [libraryId],
  )
  function begin(phase = 'preparing') {
    activeRef.current = true
    setProgress({ libraryId, phase, current: 0, total: 0, errors: [] })
    setIsCancelling(false)
    setCancelError(null)
  }
  function finish() {
    activeRef.current = false
    setIsCancelling(false)
  }
  async function cancel() {
    if (!activeRef.current || isCancelling) return
    setIsCancelling(true)
    setCancelError(null)
    try {
      const response = await window.api.library.cancelWork(libraryId)
      if (!response.ok) throw new Error(response.error)
      if (!response.value && activeRef.current) {
        setCancelError('취소할 작업이 없습니다. 완료 결과를 기다리고 있습니다.')
      }
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : '취소 요청에 실패했습니다.')
      setIsCancelling(false)
    }
  }
  return { progress, isCancelling, cancelError, begin, finish, cancel }
}

export function WorkProgress({ work, isWorking, protectDialog = false }) {
  const { progress, isCancelling, cancelError } = work
  if (!isWorking && (!progress || progress.total === 0)) return null
  const phaseNames = {
    scanning: '파일 검색 중',
    probing: '영상 정보 분석 중',
    thumbnails: '썸네일 생성 중',
    preparing: '자료 준비 중',
    applying: '변경 적용 중',
    done: isWorking ? '결과 확인 중' : '작업 종료',
    cancelled: isWorking ? '취소 정리 중' : '작업 취소됨',
  }
  const percent =
    progress?.total > 0
      ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
      : undefined
  return (
    <div className="my-3 space-y-2 rounded border border-zinc-700 bg-zinc-950/40 p-3">
      <p role="status" className="text-xs text-indigo-200">
        {!isWorking
          ? progress?.phase === 'cancelled'
            ? '작업 취소됨'
            : '작업 종료'
          : isCancelling
            ? '취소 요청 중...'
            : (phaseNames[progress?.phase] ?? '작업 진행 중')}
      </p>
      <div
        role="progressbar"
        aria-label="작업 진행률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-zinc-700"
      >
        <div
          className="h-full bg-indigo-500 transition-all"
          style={{ width: percent == null ? '0%' : `${percent}%` }}
        />
      </div>
      <p className="break-all text-xs text-zinc-400">
        {progress?.current ?? 0} / {progress?.total ?? 0}
        {progress?.currentFile ? ` · ${progress.currentFile}` : ''}
      </p>
      {cancelError && (
        <p role="alert" className="text-xs text-amber-300">
          {cancelError}
        </p>
      )}
      {isWorking && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {protectDialog && (
            <p className="text-xs text-zinc-400">
              작업 중에는 닫을 수 없습니다. 중단하려면 작업 취소를 눌러주세요.
            </p>
          )}
          <button
            type="button"
            onClick={() => void work.cancel()}
            disabled={isCancelling}
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-800 disabled:opacity-50"
          >
            {isCancelling ? '취소 요청 중...' : '작업 취소'}
          </button>
        </div>
      )}
    </div>
  )
}

function ImportDialog({ libraryId, mode = 'folder', thumbnailJobs, onClose }) {
  const qc = useQueryClient()
  const dialogRef = React.useRef(null)
  const filesMode = mode === 'files'
  const title = filesMode ? '영상 파일 추가' : '폴더 가져오기'
  const [folderPath, setFolderPath] = React.useState(null)
  const [filePaths, setFilePaths] = React.useState([])
  const work = useLibraryWorkProgress(libraryId)
  const [isImporting, setIsImporting] = React.useState(false)
  const [done, setDone] = React.useState(false)
  const [cancelled, setCancelled] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [errorMessage, setErrorMessage] = React.useState(null)
  React.useEffect(() => {
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    dialog.showModal()
    return () => {
      dialog.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  async function handleSelectFolder() {
    try {
      const res = filesMode
        ? await window.api.library.selectFiles()
        : await window.api.library.selectFolder()
      if (!res.ok) throw new Error(res.error)
      if (!res.value) return
      if (filesMode && res.value.length > 1000)
        throw new Error('한 번에 영상 파일 1,000개까지 추가할 수 있습니다. 나누어 선택해 주세요.')
      if (filesMode) setFilePaths(res.value)
      else setFolderPath(res.value)
      setDone(false)
      setCancelled(false)
      setResult(null)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '파일 선택에 실패했습니다.')
    }
  }
  async function handleImport() {
    if ((filesMode ? !filePaths.length : !folderPath) || isImporting) return
    setIsImporting(true)
    setDone(false)
    setCancelled(false)
    setResult(null)
    setErrorMessage(null)
    work.begin('scanning')
    try {
      const result = filesMode
        ? await window.api.library.importFiles(libraryId, filePaths)
        : await window.api.library.importFolder(libraryId, folderPath)
      if (!result.ok) throw new Error(result.error)
      setResult(result.value)
      setCancelled(Boolean(result.value.cancelled))
      setDone(!result.value.cancelled)
      await qc.invalidateQueries({ queryKey: ['videos', libraryId] })
      await qc.invalidateQueries({ queryKey: ['video', libraryId] })
      await qc.invalidateQueries({ queryKey: ['subtitles', libraryId] })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '가져오기에 실패했습니다.')
    } finally {
      setIsImporting(false)
      work.finish()
    }
  }
  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!isImporting) onClose()
      }}
      className={
        'm-auto max-h-[90vh] max-w-[95vw] overflow-y-auto w-[480px] rounded-xl border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-2xl backdrop:bg-black/70'
      }
    >
      <h2 className={'mb-3 text-lg font-semibold text-white'}>{title}</h2>
      <p className="mb-4 text-xs leading-relaxed text-zinc-400">
        {filesMode
          ? '영상 한 개 또는 여러 개를 골라 추가합니다. 선택한 영상만 처리하며, 해당 폴더의 다른 영상은 가져오지 않습니다. 폴더를 계속 갱신하려면 폴더 가져오기를 이용하세요.'
          : '이 폴더와 하위 폴더의 영상을 가져오고 갱신 대상으로 등록합니다. 이후 새 영상은 목록 업데이트를 눌러 반영하세요. 폴더 자동 감시는 지원하지 않습니다.'}
      </p>
      {errorMessage && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {errorMessage}
        </p>
      )}
      <div className={'mb-4 flex items-center gap-3'}>
        <div className={'flex-1 truncate rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-300'}>
          {filesMode
            ? filePaths.length
              ? `${filePaths.length}개 영상 선택됨`
              : '추가할 영상 파일을 선택하세요'
            : (folderPath ?? '가져올 폴더를 선택하세요')}
        </div>
        <button
          onClick={handleSelectFolder}
          disabled={isImporting}
          className={
            'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-40'
          }
        >
          {filesMode ? '파일 선택' : '선택'}
        </button>
      </div>
      {filesMode && filePaths.length > 0 && (
        <ul
          aria-label="선택한 영상 파일"
          className="mb-4 max-h-32 overflow-y-auto text-xs text-zinc-400"
        >
          {filePaths.map((file) => (
            <li key={file} className="break-all">
              {file}
            </li>
          ))}
        </ul>
      )}
      <WorkProgress work={work} isWorking={isImporting} protectDialog />
        {isImporting && work.progress?.phase === 'thumbnails' && thumbnailJobs && (
          <section aria-label="가져오기 썸네일 작업" className="mb-3 space-y-2">
            <p className="text-xs text-zinc-400">
              영상별 진행 상태를 확인하고 필요한 작업만 취소할 수 있습니다.
            </p>
            {thumbnailJobs.error && (
              <p role="alert" className="text-xs text-amber-200">
                썸네일 진행 상태를 갱신하지 못했습니다.
              </p>
            )}
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {[...thumbnailJobs.jobsByVideo.values()]
                .filter(
                  (job) =>
                    isThumbnailJobActive(job) ||
                    job.phase === 'failed' ||
                    job.phase === 'cancelled',
                )
                .map((job) => (
                  <div key={job.videoId}>
                    <p className="mb-1 truncate text-xs text-zinc-300" title={job.fileName}>
                      {job.fileName}
                    </p>
                    <ThumbnailJobStatus
                      job={job}
                      label={`${job.fileName} 가져오기 썸네일 작업`}
                      onCancel={() => thumbnailJobs.cancelVideo(job.videoId)}
                      isCancelling={thumbnailJobs.cancellingVideos.has(job.videoId)}
                      cancelError={thumbnailJobs.cancelErrors.get(job.videoId)}
                    />
                  </div>
                ))}
            </div>
          </section>
        )}
      {done && (
        <p role="status" className="mb-3 text-xs text-green-400">
          가져오기 완료 (추가 {result?.added ?? 0}개, 건너뜀 {result?.skipped ?? 0}개)
        </p>
      )}
      {cancelled && (
        <p role="status" className="mb-3 text-xs text-amber-300">
          작업이 취소되었습니다. 처리된 항목은 목록에 반영되었습니다.
        </p>
      )}
      {result?.errors.length > 0 && (
        <div
          role="alert"
          className="mb-3 max-h-32 overflow-y-auto break-words text-xs text-amber-300"
        >
          <p>처리하지 못한 항목 {result.errors.length}개가 있습니다.</p>
          <ul>
            {result.errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className={'flex justify-end gap-3'}>
        <button
          onClick={onClose}
          disabled={isImporting}
          className={'rounded px-4 py-2 text-sm text-zinc-400 hover:text-white disabled:opacity-40'}
        >
          {'닫기'}
        </button>
        <button
          onClick={handleImport}
          disabled={(filesMode ? !filePaths.length : !folderPath) || isImporting || done}
          className={
            'rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40'
          }
        >
          {isImporting ? '가져오는 중...' : filesMode ? '선택한 영상 추가' : '가져오기'}
        </button>
      </div>
    </dialog>
  )
}
export default ImportDialog
