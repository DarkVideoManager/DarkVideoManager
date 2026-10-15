// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dataImportApi } from '../../api'
import { useLibraryWorkProgress, WorkProgress } from './ImportDialog'
const DEFAULT_OPTIONS$1 = {
  importRatings: true,
  importFavoritesAsHighlights: true,
}
function CsvImportDialog({ libraryId, onClose }) {
  const qc2 = useQueryClient()
  const [csvPath, setCsvPath] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [options, setOptions] = React.useState(DEFAULT_OPTIONS$1)
  const [errorMessage, setErrorMessage] = React.useState(null)
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false)
  const [isImporting, setIsImporting] = React.useState(false)
  const work = useLibraryWorkProgress(libraryId)
  const isBusy = isPreviewLoading || isImporting
  async function handleSelectCsv() {
    const res = await dataImportApi.selectCsv()
    if (!res.ok || !res.value) return
    setCsvPath(res.value)
    setPreview(null)
    setResult(null)
    setErrorMessage(null)
  }
  async function handlePreview() {
    if (!csvPath || isBusy) return
    setIsPreviewLoading(true)
    setPreview(null)
    setResult(null)
    setErrorMessage(null)
    work.begin('preparing')
    try {
      const res = await dataImportApi.preview(libraryId, csvPath)
      if (!res.ok) throw new Error(res.error)
      setPreview(res.value)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '분석에 실패했습니다.')
    } finally {
      setIsPreviewLoading(false)
      work.finish()
    }
  }
  async function handleImport() {
    if (!csvPath || isBusy) return
    setIsImporting(true)
    setResult(null)
    setErrorMessage(null)
    work.begin('applying')
    try {
      const res = await dataImportApi.importCsv(libraryId, csvPath, options)
      if (!res.ok) throw new Error(res.error)
      setResult(res.value)
      await Promise.all([
        qc2.invalidateQueries({ queryKey: ['videos', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['video', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['video-metadata-options', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['highlights', libraryId] }),
      ])
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '가져오기에 실패했습니다.')
    } finally {
      setIsImporting(false)
      work.finish()
    }
  }
  return (
    <div className={'fixed inset-0 z-50 flex items-center justify-center bg-black/70'}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="CSV 가져오기"
        className={
          'max-h-[90vh] max-w-[95vw] overflow-y-auto w-[720px] rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl'
        }
      >
        <div className={'mb-4'}>
          <h2 className={'text-lg font-semibold text-white'}>{'CSV 가져오기'}</h2>
          <p className={'mt-1 text-sm text-zinc-400'}>
            {'`Files` 테이블의 별점과 `Favorites` 테이블의 즐겨찾기 위치를 가져옵니다.'}
          </p>
        </div>
        <div className={'mb-4 flex items-center gap-3'}>
          <div className={'flex-1 truncate rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-300'}>
            {csvPath ?? '분석할 CSV 파일을 선택하세요'}
          </div>
          <button
            onClick={handleSelectCsv}
            disabled={isPreviewLoading || isImporting}
            className={
              'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-40'
            }
          >
            {'CSV 선택'}
          </button>
          <button
            onClick={handlePreview}
            disabled={!csvPath || isPreviewLoading || isImporting}
            className={
              'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-40'
            }
          >
            {isPreviewLoading ? '분석 중...' : '분석'}
          </button>
        </div>
        <fieldset disabled={isBusy} className={'mb-4 grid grid-cols-2 gap-3 text-sm text-zinc-300'}>
          <label
            className={
              'flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2'
            }
          >
            <input
              type={'checkbox'}
              checked={options.importRatings}
              onChange={(event) =>
                setOptions((prev) => ({
                  ...prev,
                  importRatings: event.target.checked,
                }))
              }
            />
            {'`Files`의 별점 가져오기'}
          </label>
          <label
            className={
              'flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2'
            }
          >
            <input
              type={'checkbox'}
              checked={options.importFavoritesAsHighlights}
              onChange={(event) =>
                setOptions((prev) => ({
                  ...prev,
                  importFavoritesAsHighlights: event.target.checked,
                }))
              }
            />
            {'즐겨찾기를 하이라이트로 가져오기'}
          </label>
        </fieldset>
        <WorkProgress work={work} isWorking={isBusy} protectDialog />
        {preview && (
          <div className={'mb-4 rounded border border-zinc-800 bg-zinc-950 p-4'}>
            <p className={'mb-3 text-sm font-medium text-white'}>{'미리보기'}</p>
            <div className={'grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-zinc-300'}>
              <PreviewRow$1 label={'전체 행 수'} value={preview.totalRows} />
              <PreviewRow$1 label={'Files 행 수'} value={preview.filesRows} />
              <PreviewRow$1 label={'Favorites 행 수'} value={preview.favoritesRows} />
              <PreviewRow$1 label={'별점 있는 Files'} value={preview.ratedFileRows} />
              <PreviewRow$1
                label={'시작 위치 있는 Favorites'}
                value={preview.favoriteRowsWithStart}
              />
              <PreviewRow$1 label={'매칭된 별점'} value={preview.matchedRatingRows} />
              <PreviewRow$1 label={'애매한 별점'} value={preview.ambiguousRatingRows} />
              <PreviewRow$1 label={'매칭 실패 별점'} value={preview.unmatchedRatingRows} />
              <PreviewRow$1 label={'매칭된 즐겨찾기'} value={preview.matchedFavoriteRows} />
              <PreviewRow$1 label={'애매한 즐겨찾기'} value={preview.ambiguousFavoriteRows} />
              <PreviewRow$1 label={'매칭 실패 즐겨찾기'} value={preview.unmatchedFavoriteRows} />
            </div>
          </div>
        )}
        {result && (
          <div
            className={
              'mb-4 rounded border border-emerald-900 bg-emerald-950/30 p-4 text-sm text-emerald-200'
            }
          >
            <p className={'font-medium text-emerald-100'}>{'가져오기 완료'}</p>
            <p className={'mt-1'}>
              {'업데이트된 별점: '}
              {result.ratingsUpdated}
            </p>
            <p>
              {'추가된 하이라이트: '}
              {result.highlightsAdded}
            </p>
          </div>
        )}
        {errorMessage && (
          <div
            role="alert"
            className={
              'mb-4 rounded border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-200'
            }
          >
            {errorMessage}
          </div>
        )}
        <div className={'flex justify-end gap-3'}>
          <button
            onClick={onClose}
            disabled={isBusy}
            className={
              'rounded px-4 py-2 text-sm text-zinc-400 hover:text-white disabled:opacity-40'
            }
          >
            {'닫기'}
          </button>
          <button
            onClick={handleImport}
            disabled={
              !preview || isBusy || (!options.importRatings && !options.importFavoritesAsHighlights)
            }
            className={
              'rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40'
            }
          >
            {isImporting ? '가져오는 중...' : '가져오기 적용'}
          </button>
        </div>
      </div>
    </div>
  )
}
function PreviewRow$1({ label, value }) {
  return (
    <React.Fragment>
      <span className={'text-zinc-500'}>{label}</span>
      <span className={'text-right text-zinc-100'}>{value.toLocaleString()}</span>
    </React.Fragment>
  )
}
export default CsvImportDialog
