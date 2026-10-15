import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  CleanupRuleZ,
  type DuplicateResult,
  type RenamePreview,
  type RenameResult,
} from '@shared/maintenance'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraries } from '../api/useLibraries'

const button =
  'rounded border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40'
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function RenameConfirmation({
  count,
  files,
  onCancel,
  onConfirm,
}: {
  count: number
  files: number
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby="rename-confirm-title"
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      className="w-[min(90vw,32rem)] rounded-xl border border-zinc-600 bg-zinc-900 p-6 text-zinc-100 backdrop:bg-black/70"
    >
      <h2 id="rename-confirm-title" className="text-lg font-semibold">
        파일명 변경 확인
      </h2>
      <p className="my-4 text-sm leading-relaxed">
        선택한 영상 {count}개에 연결된 파일 {files}개의 실제 이름과 라이브러리 경로를 변경합니다.
        미리보기에 표시된 외부 자막도 함께 변경하며, 제목·태그·재생 기록은 유지합니다.
      </p>
      <p className="mb-5 text-sm text-zinc-400">
        파일 내용은 바꾸지 않습니다. 취소하면 아직 시작하지 않은 항목은 그대로 두며, 이미 완료한
        항목은 결과에 표시합니다.
      </p>
      <div className="flex justify-end gap-3">
        <button type="button" className={button} autoFocus onClick={onCancel}>
          돌아가기
        </button>
        <button type="button" className={button + ' bg-indigo-600'} onClick={onConfirm}>
          확인 후 변경
        </button>
      </div>
    </dialog>
  )
}

function MaintenancePanel({ libraryId, libraryName }: { libraryId: string; libraryName: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const setSelectedVideoId = useLibraryStore((state) => state.setSelectedVideoId)
  const [prefix, setPrefix] = useState('')
  const [preview, setPreview] = useState<RenamePreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [renamed, setRenamed] = useState<RenameResult | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null)
  const [operation, setOperation] = useState<'preview' | 'rename' | 'duplicates' | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const working = useRef(false)
  const busy = operation !== null
  const validPrefix = CleanupRuleZ.safeParse({ prefix }).success
  const ready = preview?.rows.filter((row) => !row.error) ?? []
  const chosen = preview?.rows.filter((row) => selected.includes(row.videoId) && !row.error) ?? []
  useEffect(
    () => () => {
      if (working.current) void window.api.maintenance.cancel(libraryId).catch(() => undefined)
    },
    [libraryId],
  )

  async function run(kind: NonNullable<typeof operation>, task: () => Promise<void>) {
    if (working.current) return
    working.current = true
    setOperation(kind)
    setCancelling(false)
    setError(null)
    try {
      await task()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      working.current = false
      setOperation(null)
      setCancelling(false)
    }
  }
  async function previewNames() {
    setPreview(null)
    setSelected([])
    setRenamed(null)
    await run('preview', async () => {
      const result = await window.api.maintenance.previewNames(libraryId, { prefix })
      if (!result.ok) throw new Error(result.error)
      setPreview(result.value)
      setSelected(result.value.rows.filter((row) => !row.error).map((row) => row.videoId))
    })
  }
  async function applyNames() {
    setConfirm(false)
    if (!preview || !chosen.length) return
    await run('rename', async () => {
      const result = await window.api.maintenance.applyNames(
        libraryId,
        preview.id,
        chosen.map((row) => row.videoId),
      )
      if (!result.ok) throw new Error(result.error)
      setRenamed(result.value)
      setPreview(null)
      setSelected([])
      setDuplicates(null)
      for (const key of [
        'videos',
        'video',
        'subtitles',
        'subtitle-tracks',
        'subtitle-cues',
        'playback-source',
        'stats',
      ])
        await queryClient.invalidateQueries({ queryKey: [key, libraryId] })
    })
  }
  async function findDuplicates() {
    setDuplicates(null)
    await run('duplicates', async () => {
      const result = await window.api.maintenance.findDuplicates(libraryId)
      if (!result.ok) throw new Error(result.error)
      setDuplicates(result.value)
    })
  }
  async function cancel() {
    setCancelling(true)
    try {
      const result = await window.api.maintenance.cancel(libraryId)
      if (!result.ok) throw new Error(result.error)
    } catch (cause) {
      setError(errorMessage(cause))
      setCancelling(false)
    }
  }
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">파일 정리</h1>
        <p className="mt-1 text-sm text-zinc-400">{libraryName} · 현재 라이브러리의 원본 영상</p>
      </div>
      <p className="text-sm leading-relaxed text-zinc-400">
        재생 중인 영상과 대기·일시정지 작업이 있는 영상은 제외합니다. 파일명 변경은 실제 파일에
        적용되며, 다른 라이브러리와 공유하는 파일은 변경하지 않습니다.
      </p>
      {busy && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-indigo-800 p-3">
          <p role="status">
            {operation === 'preview'
              ? '파일명 변경 내용을 확인하는 중...'
              : operation === 'rename'
                ? '선택한 파일명을 변경하는 중...'
                : '크기가 같은 파일의 전체 내용을 비교하는 중... 큰 영상은 시간이 걸릴 수 있습니다.'}
          </p>
          <button
            type="button"
            className={button}
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? '취소 요청 중...' : '작업 취소'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="break-words rounded bg-red-950/50 p-3 text-sm text-red-300">
          {error}
        </p>
      )}
      <section
        aria-labelledby="filename-cleanup-title"
        className="space-y-4 rounded-lg border border-zinc-700 bg-zinc-900/50 p-4"
      >
        <h2 id="filename-cleanup-title" className="font-semibold">
          파일명 앞의 문자열 제거
        </h2>
        <p className="text-sm text-zinc-400">
          입력한 문자열과 정확히 일치하는 접두어를 한 번 제거하고, 남은 이름 양끝의 공백을
          정리합니다. 확장자는 유지합니다. 정규식은 사용하지 않습니다.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (validPrefix && !busy) void previewNames()
          }}
        >
          <label className="min-w-0 flex-1 text-sm">
            제거할 접두어
            <input
              value={prefix}
              disabled={busy}
              maxLength={200}
              onChange={(event) => {
                setPrefix(event.target.value)
                setPreview(null)
                setSelected([])
                setRenamed(null)
              }}
              placeholder="예: [광고] "
              className="mt-2 block w-full rounded border border-zinc-600 bg-zinc-950 p-2"
            />
          </label>
          <button type="submit" className={button} disabled={!validPrefix || busy}>
            미리보기
          </button>
        </form>
        {preview && (
          <div className="space-y-3">
            <p className="text-sm">
              변경 후보 {preview.rows.length}개 · 변경 가능 {ready.length}개 · 선택 {chosen.length}
              개
            </p>
            {preview.truncated && (
              <p role="status" className="text-sm text-amber-200">
                한 번에 최대 500개를 표시합니다. 적용 후 다시 미리보기하여 나머지를 확인하세요.
              </p>
            )}
            {preview.rows.length === 0 ? (
              <p className="text-sm text-zinc-400">이 접두어로 시작하는 파일이 없습니다.</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={busy || !ready.length}
                    checked={ready.length > 0 && chosen.length === ready.length}
                    onChange={(event) =>
                      setSelected(event.target.checked ? ready.map((row) => row.videoId) : [])
                    }
                  />
                  변경 가능한 항목 모두 선택
                </label>
                <div className="max-h-[32rem] space-y-2 overflow-y-auto">
                  {preview.rows.map((row) => (
                    <article
                      key={row.videoId}
                      aria-label={`${row.fileName} 파일명 변경`}
                      className="space-y-2 rounded border border-zinc-700 p-3"
                    >
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={busy || Boolean(row.error)}
                          checked={selected.includes(row.videoId)}
                          onChange={(event) =>
                            setSelected((ids) =>
                              event.target.checked
                                ? [...ids, row.videoId]
                                : ids.filter((id) => id !== row.videoId),
                            )
                          }
                        />
                        <span className="min-w-0 break-all">
                          {row.fileName} → <strong>{row.nextName}</strong>
                        </span>
                      </label>
                      {row.files.map((file) => (
                        <p key={file.from} className="break-all text-xs text-zinc-400">
                          {file.kind === 'video' ? '영상' : '자막'}: {file.from}
                          <br />→ {file.to}
                        </p>
                      ))}
                      {row.error && (
                        <p className="text-xs text-amber-200">변경 불가: {row.error}</p>
                      )}
                    </article>
                  ))}
                </div>
                <button
                  type="button"
                  className={button + ' bg-indigo-600'}
                  disabled={busy || !chosen.length}
                  onClick={() => setConfirm(true)}
                >
                  선택한 이름 변경
                </button>
              </>
            )}
          </div>
        )}
        {renamed && (
          <div aria-label="파일명 변경 결과" className="space-y-2 text-sm">
            <p role="status">
              {renamed.cancelled ? '취소되었습니다. ' : ''}변경 완료{' '}
              {renamed.items.filter((item) => item.status === 'renamed').length}개 · 실패{' '}
              {renamed.items.filter((item) => item.status === 'failed').length}개 · 변경 안 함{' '}
              {renamed.items.filter((item) => item.status === 'cancelled').length}개
            </p>
            {renamed.items
              .filter((item) => item.status === 'failed')
              .map((item) => (
                <p key={item.videoId} className="break-all text-amber-200">
                  {item.fileName}: {item.message}
                </p>
              ))}
            <p className="text-xs text-zinc-400">다른 항목을 변경하려면 다시 미리보기하세요.</p>
          </div>
        )}
      </section>
      <section
        aria-labelledby="duplicate-title"
        className="space-y-4 rounded-lg border border-zinc-700 bg-zinc-900/50 p-4"
      >
        <h2 id="duplicate-title" className="font-semibold">
          내용이 정확히 같은 파일 찾기
        </h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          실제 파일 크기가 같은 항목의 전체 내용을 SHA-256으로 비교합니다. 파일명이나 화질이 비슷한
          영상, 재인코딩한 영상은 유사 영상으로 판단하지 않습니다. 결과는 검사 시점의 후보이며
          파일을 자동 삭제하지 않습니다.
        </p>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void findDuplicates()}
        >
          정확한 중복 후보 찾기
        </button>
        {duplicates && (
          <div className="space-y-3">
            <p role="status">
              {duplicates.cancelled ? '검사를 취소했습니다. 완료한 비교 결과만 표시합니다. ' : ''}
              전체 해시 확인 {duplicates.checkedFiles}개 · 중복 후보 그룹 {duplicates.groups.length}
              개 · 제외 {duplicates.skipped.length}개
            </p>
            {!duplicates.groups.length && (
              <p className="text-sm text-zinc-400">
                검사를 마친 파일에서 정확한 중복 후보가 없습니다.
              </p>
            )}
            {duplicates.groups.map((group, index) => (
              <article
                key={group.sha256 + ':' + group.sizeBytes}
                aria-label={`동일 파일 후보 그룹 ${index + 1}`}
                className="space-y-3 rounded border border-zinc-700 p-3"
              >
                <h3 className="text-sm font-medium">
                  그룹 {index + 1} · {group.files.length}개 · 각{' '}
                  {(group.sizeBytes / 1024 / 1024).toLocaleString('ko-KR', {
                    maximumFractionDigits: 2,
                  })}{' '}
                  MiB
                </h3>
                {group.files.map((file) => (
                  <div key={file.videoId} className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-all text-sm">{file.fileName}</p>
                      <p className="break-all text-xs text-zinc-400">{file.filePath}</p>
                    </div>
                    <button
                      type="button"
                      className={button}
                      onClick={() => {
                        setSelectedVideoId(file.videoId)
                        navigate('/')
                      }}
                    >
                      라이브러리에서 확인
                    </button>
                  </div>
                ))}
                <details className="text-xs text-zinc-400">
                  <summary>SHA-256 확인</summary>
                  <p className="mt-1 break-all">{group.sha256}</p>
                </details>
              </article>
            ))}
            {duplicates.skipped.length > 0 && (
              <details className="space-y-2 text-sm">
                <summary>제외한 파일과 이유</summary>
                {duplicates.skipped.map((item) => (
                  <p key={item.videoId} className="break-all text-xs text-amber-200">
                    {item.fileName}: {item.reason}
                  </p>
                ))}
              </details>
            )}
            <p className="text-xs text-zinc-400">
              정리가 필요하면 라이브러리에서 영상과 경로를 다시 확인한 뒤 기존 삭제 기능을
              사용하세요. 하드 링크는 같은 실제 저장 공간을 공유할 수 있습니다.
            </p>
          </div>
        )}
      </section>
      {confirm && (
        <RenameConfirmation
          count={chosen.length}
          files={chosen.reduce((total, row) => total + row.files.length, 0)}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void applyNames()}
        />
      )}
    </div>
  )
}

export default function LibraryMaintenancePage() {
  const activeLibraryId = useLibraryStore((state) => state.activeLibraryId)
  const openedLibraryId = useLibraryStore((state) => state.openedLibraryId)
  const { data: libraries = [] } = useLibraries()
  return (
    <section
      aria-label="라이브러리 파일 정리"
      className="min-w-0 w-full overflow-y-auto p-4 sm:p-6"
    >
      {activeLibraryId && openedLibraryId === activeLibraryId ? (
        <MaintenancePanel
          key={activeLibraryId}
          libraryId={activeLibraryId}
          libraryName={
            libraries.find((library) => library.id === activeLibraryId)?.name ?? '라이브러리'
          }
        />
      ) : (
        <div className="space-y-4">
          <h1 className="text-xl font-semibold">파일 정리</h1>
          <p>정리할 라이브러리를 먼저 열어 주세요.</p>
          <Link to="/" className="text-indigo-300 underline">
            라이브러리로 이동
          </Link>
        </div>
      )}
    </section>
  )
}
