// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { dataImportApi } from '../../api'
import { useLibraryWorkProgress, WorkProgress } from './ImportDialog'
const DEFAULT_OPTIONS = {
  importRatings: true,
  importFavoritesAsHighlights: true,
  importThumbnails: true,
  importMetadata: true,
}
function DeepDarkDbImportDialog({ libraryId, onClose }) {
  const qc2 = useQueryClient()
  const [dbPath, setDbPath] = React.useState(null)
  const [preview, setPreview] = React.useState(null)
  const [result, setResult] = React.useState(null)
  const [options, setOptions] = React.useState(DEFAULT_OPTIONS)
  const [errorMessage, setErrorMessage] = React.useState(null)
  const [isPreviewLoading, setIsPreviewLoading] = React.useState(false)
  const [isImporting, setIsImporting] = React.useState(false)
  const work = useLibraryWorkProgress(libraryId)
  const isBusy = isPreviewLoading || isImporting
  async function handleSelectDb() {
    const res = await dataImportApi.selectDeepDarkDb()
    if (!res.ok || !res.value) return
    setDbPath(res.value)
    setPreview(null)
    setResult(null)
    setErrorMessage(null)
  }
  async function handlePreview() {
    if (!dbPath || isBusy) return
    setIsPreviewLoading(true)
    setPreview(null)
    setResult(null)
    setErrorMessage(null)
    work.begin('preparing')
    try {
      const res = await dataImportApi.previewDeepDarkDb(libraryId, dbPath)
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
    if (!dbPath || isBusy) return
    setIsImporting(true)
    setResult(null)
    setErrorMessage(null)
    work.begin('applying')
    try {
      const res = await dataImportApi.importDeepDarkDb(libraryId, dbPath, options)
      if (!res.ok) throw new Error(res.error)
      setResult(res.value)
      await Promise.all([
        qc2.invalidateQueries({ queryKey: ['videos', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['video', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['highlights', libraryId] }),
        qc2.invalidateQueries({ queryKey: ['thumbnails', libraryId] }),
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
        aria-label="deepdark.db 가져오기"
        className={
          'max-h-[90vh] max-w-[95vw] overflow-y-auto w-[760px] rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl'
        }
      >
        <div className={'mb-4'}>
          <h2 className={'text-lg font-semibold text-white'}>{'deepdark.db 가져오기'}</h2>
          <p className={'mt-1 text-sm text-zinc-400'}>
            {
              '원본 데이터베이스에서 별점, 즐겨찾기, 썸네일, 제목, 태그, 재생 횟수, 마지막 재생일을 가져옵니다.'
            }
          </p>
        </div>
        <div className={'mb-4 flex items-center gap-3'}>
          <div className={'flex-1 truncate rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-300'}>
            {dbPath ?? '분석할 deepdark.db 파일을 선택하세요'}
          </div>
          <button
            onClick={handleSelectDb}
            disabled={isPreviewLoading || isImporting}
            className={
              'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-40'
            }
          >
            {'DB 선택'}
          </button>
          <button
            onClick={handlePreview}
            disabled={!dbPath || isPreviewLoading || isImporting}
            className={
              'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-40'
            }
          >
            {isPreviewLoading ? '분석 중...' : '분석'}
          </button>
        </div>
        <fieldset disabled={isBusy} className={'mb-4 grid grid-cols-2 gap-3 text-sm text-zinc-300'}>
          <OptionCheckbox
            checked={options.importRatings}
            label={'별점 가져오기'}
            onChange={(checked) =>
              setOptions((prev) => ({
                ...prev,
                importRatings: checked,
              }))
            }
          />
          <OptionCheckbox
            checked={options.importFavoritesAsHighlights}
            label={'즐겨찾기를 하이라이트로 가져오기'}
            onChange={(checked) =>
              setOptions((prev) => ({
                ...prev,
                importFavoritesAsHighlights: checked,
              }))
            }
          />
          <OptionCheckbox
            checked={options.importThumbnails}
            label={'썸네일 블롭 가져오기'}
            onChange={(checked) =>
              setOptions((prev) => ({
                ...prev,
                importThumbnails: checked,
              }))
            }
          />
          <OptionCheckbox
            checked={options.importMetadata}
            label={'제목, 태그, 재생 횟수, 재생일 가져오기'}
            onChange={(checked) =>
              setOptions((prev) => ({
                ...prev,
                importMetadata: checked,
              }))
            }
          />
        </fieldset>
        <WorkProgress work={work} isWorking={isBusy} protectDialog />
        {preview && (
          <div className={'mb-4 rounded border border-zinc-800 bg-zinc-950 p-4'}>
            <p className={'mb-3 text-sm font-medium text-white'}>{'미리보기'}</p>
            <div className={'grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-zinc-300'}>
              <PreviewRow label={'Files 행 수'} value={preview.filesRows} />
              <PreviewRow label={'Favorites 행 수'} value={preview.favoritesRows} />
              <PreviewRow label={'DVD 행 수'} value={preview.dvdRows} />
              <PreviewRow label={'썸네일 있는 Files'} value={preview.filesWithThumb} />
              <PreviewRow label={'썸네일 있는 Favorites'} value={preview.favoritesWithThumb} />
              <PreviewRow label={'매칭된 Files'} value={preview.matchedFilesRows} />
              <PreviewRow label={'애매한 Files'} value={preview.ambiguousFilesRows} />
              <PreviewRow label={'매칭 실패 Files'} value={preview.unmatchedFilesRows} />
              <PreviewRow label={'매칭된 Favorites'} value={preview.matchedFavoriteRows} />
              <PreviewRow label={'애매한 Favorites'} value={preview.ambiguousFavoriteRows} />
              <PreviewRow label={'매칭 실패 Favorites'} value={preview.unmatchedFavoriteRows} />
            </div>
            <div className={'mt-4 rounded border border-zinc-800 bg-zinc-900/60 p-3'}>
              <p className={'mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400'}>
                {'자동 매칭 규칙'}
              </p>
              <div className={'space-y-1 text-xs text-zinc-300'}>
                {preview.matchingRules.map((rule) => (
                  <p key={rule}>{rule}</p>
                ))}
              </div>
            </div>
            <div className={'mt-4 grid grid-cols-2 gap-4'}>
              <IssueList title={'애매한 Files'} items={preview.ambiguousFilesSample} />
              <IssueList title={'매칭 실패 Files'} items={preview.unmatchedFilesSample} />
              <IssueList title={'애매한 Favorites'} items={preview.ambiguousFavoriteSample} />
              <IssueList title={'매칭 실패 Favorites'} items={preview.unmatchedFavoriteSample} />
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
            <p>
              {'가져온 썸네일: '}
              {result.thumbnailsImported}
            </p>
            <p>
              {'업데이트된 메타데이터: '}
              {result.metadataUpdated}
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
              !preview ||
              isBusy ||
              (!options.importRatings &&
                !options.importFavoritesAsHighlights &&
                !options.importThumbnails &&
                !options.importMetadata)
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
function PreviewRow({ label, value }) {
  return (
    <React.Fragment>
      <span className={'text-zinc-500'}>{label}</span>
      <span className={'text-right text-zinc-100'}>{value.toLocaleString()}</span>
    </React.Fragment>
  )
}
function OptionCheckbox({ checked, label, onChange }) {
  return (
    <label
      className={'flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-3 py-2'}
    >
      <input
        type={'checkbox'}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}
function IssueList({ title, items }) {
  return (
    <div className={'rounded border border-zinc-800 bg-zinc-900/60 p-3'}>
      <p className={'mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400'}>{title}</p>
      {items.length === 0 ? (
        <p className={'text-xs text-zinc-500'}>{'없음'}</p>
      ) : (
        <div className={'max-h-40 space-y-2 overflow-y-auto text-xs text-zinc-300'}>
          {items.map((item, index) => (
            <div className={'rounded bg-zinc-950 px-2 py-1.5'} key={`${item.importPath}-${index}`}>
              <p className={'break-all'}>{item.importPath}</p>
              {item.candidates && item.candidates.length > 0 && (
                <p className={'mt-1 text-zinc-500'}>
                  {'후보: '}
                  {item.candidates.join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
export default DeepDarkDbImportDialog
