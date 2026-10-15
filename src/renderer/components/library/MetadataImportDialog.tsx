import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { Video } from '@shared/types'
import {
  importedMetadata,
  mergeImportedTags,
  type ImportedMetadata,
  type MetadataApplyResult,
  type MetadataCandidate,
  type MetadataSearchResult,
  type MetadataSearchMode,
  type StashSettings,
} from '@shared/metadataImport'

const inputClass =
  'w-full rounded border border-zinc-600 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 disabled:opacity-50'
const buttonClass =
  'rounded bg-zinc-700 px-3 py-2 text-sm text-white hover:bg-zinc-600 disabled:opacity-50'
const fields = ['title', 'memo', 'tags'] as const
type Field = (typeof fields)[number]

export default function MetadataImportDialog({
  video,
  libraryId,
  onClose,
}: {
  video: Video
  libraryId: string
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const alive = useRef(true)
  const qc = useQueryClient()
  const [settings, setSettings] = useState<StashSettings>({
    enabled: false,
    serverUrl: '',
    hasApiKey: false,
  })
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState(video.fileName.replace(/\.[^.]+$/, '').slice(0, 200))
  const [searchMode, setSearchMode] = useState<MetadataSearchMode>('text')
  const [result, setResult] = useState<MetadataSearchResult | null>(null)
  const [candidate, setCandidate] = useState<MetadataCandidate | null>(null)
  const [baseline, setBaseline] = useState(() => importedMetadata(video))
  const [draft, setDraft] = useState<ImportedMetadata>(() => importedMetadata(video))
  const [selected, setSelected] = useState<Record<Field, boolean>>({
    title: false,
    memo: false,
    tags: false,
  })
  const [undo, setUndo] = useState<{ result: MetadataApplyResult; keys: Field[] } | null>(null)

  useEffect(() => {
    alive.current = true
    dialogRef.current?.showModal()
    void Promise.all([
      window.api.metadataImport.getSettings(),
      window.api.videos.get(libraryId, video.id),
    ])
      .then(([settingsResult, videoResult]) => {
        if (!alive.current) return
        if (!settingsResult.ok) throw new Error(settingsResult.error)
        if (!videoResult.ok) throw new Error(videoResult.error)
        if (!videoResult.value || videoResult.value.removalMode)
          throw new Error('영상을 찾을 수 없습니다.')
        setSettings(settingsResult.value)
        setBaseline(importedMetadata(videoResult.value))
        setReady(true)
      })
      .catch((reason: unknown) => {
        if (alive.current)
          setError(reason instanceof Error ? reason.message : '설정을 불러오지 못했습니다.')
      })
    return () => {
      alive.current = false
    }
  }, [libraryId, video.id])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : '작업에 실패했습니다.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function saveSettings() {
    await run(async () => {
      const response = await window.api.metadataImport.updateSettings({
        enabled: settings.enabled,
        serverUrl: settings.serverUrl,
        apiKey: apiKey || undefined,
        removeApiKey: removeKey,
      })
      if (!response.ok) throw new Error(response.error)
      if (!alive.current) return
      setSettings(response.value)
      setApiKey('')
      setRemoveKey(false)
      setSettingsDirty(false)
      setResult(null)
      setCandidate(null)
      setNotice('연결 설정을 저장했습니다. 조회 버튼을 눌러야 서버에 요청합니다.')
    })
  }
  async function search() {
    setResult(null)
    setCandidate(null)
    await run(async () => {
      const response = await window.api.metadataImport.search(query.trim(), searchMode)
      if (!response.ok) throw new Error(response.error)
      if (alive.current) setResult(response.value)
    })
  }
  function choose(value: MetadataCandidate) {
    setCandidate(value)
    setDraft({
      title: value.title,
      memo: value.description,
      tags: mergeImportedTags(baseline.tags, value.tags),
    })
    // Existing content is never selected for replacement automatically.
    setSelected({ title: false, memo: false, tags: false })
    setError('')
    setNotice('적용할 항목을 선택하고 값을 확인하세요. 태그는 기존 태그와 합쳐 표시합니다.')
  }
  function refresh() {
    void qc.invalidateQueries({ queryKey: ['video', libraryId, video.id] })
    void qc.invalidateQueries({ queryKey: ['videos', libraryId] })
    void qc.invalidateQueries({ queryKey: ['video-metadata-options', libraryId] })
    void qc.invalidateQueries({ queryKey: ['stats', libraryId] })
  }
  async function apply(reverse = false) {
    const keys = reverse && undo ? undo.keys : fields.filter((key) => selected[key])
    const source = reverse && undo ? undo.result.before : draft
    const expected = reverse && undo ? undo.result.after : baseline
    const patch = Object.fromEntries(keys.map((key) => [key, source[key]]))
    await run(async () => {
      const response = await window.api.metadataImport.apply(libraryId, video.id, {
        expected,
        patch,
      })
      if (!response.ok) throw new Error(response.error)
      refresh()
      if (!alive.current) return
      setBaseline(response.value.after)
      setUndo(reverse ? null : { result: response.value, keys })
      setCandidate(null)
      setNotice(
        reverse
          ? '방금 적용한 항목을 이전 값으로 되돌렸습니다.'
          : '선택한 항목을 적용했습니다. 이 창을 닫기 전까지 방금 적용 되돌리기를 사용할 수 있습니다.',
      )
    })
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="metadata-import-title"
      className="fixed inset-0 m-auto max-h-[90vh] w-[min(48rem,94vw)] overflow-y-auto rounded-xl border border-zinc-600 bg-zinc-950 p-6 text-zinc-100 shadow-2xl backdrop:bg-black/70"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="metadata-import-title" className="text-lg font-semibold">
          Stash에서 정보 가져오기
        </h2>
        <button type="button" className={buttonClass} onClick={onClose} disabled={busy}>
          닫기
        </button>
      </div>
      <p className="mt-2 text-sm text-zinc-300">
        지정한 Stash 서버에서 후보를 조회한 뒤, 확인·수정한 항목만 저장합니다. 표지 다운로드와 외부
        사이트 자동 수집은 지원하지 않습니다.
      </p>
      <fieldset
        disabled={!ready || busy}
        className="mt-4 space-y-3 rounded border border-zinc-700 p-4"
      >
        <legend className="px-1 text-sm font-medium">Stash 연결 설정</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => {
              setSettings({ ...settings, enabled: e.target.checked })
              setSettingsDirty(true)
            }}
          />
          Stash 연결 사용
        </label>
        <label className="block text-sm">
          Stash 서버 주소
          <input
            className={`${inputClass} mt-1`}
            type="url"
            placeholder="http://localhost:9999"
            value={settings.serverUrl}
            onChange={(e) => {
              setSettings({ ...settings, serverUrl: e.target.value })
              setSettingsDirty(true)
            }}
          />
        </label>
        <p className="text-xs text-zinc-400">
          HTTPS 또는 localhost·127.0.0.1·[::1]의 HTTP만 허용합니다. Stash-box 주소는 지원하지
          않습니다. 서버 주소를 바꾸면 저장된 키를 제거합니다.
        </p>
        <label className="block text-sm">
          Stash API 키
          <input
            className={`${inputClass} mt-1`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            placeholder={
              settings.hasApiKey ? '저장된 키 있음 — 비워두면 유지' : '인증이 필요하면 입력'
            }
            onChange={(e) => {
              setApiKey(e.target.value)
              setSettingsDirty(true)
            }}
          />
        </label>
        {settings.hasApiKey && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeKey}
              onChange={(e) => {
                setRemoveKey(e.target.checked)
                setSettingsDirty(true)
              }}
            />
            저장된 Stash API 키 삭제
          </label>
        )}
        <p className="text-xs text-zinc-400">
          기본으로 꺼져 있습니다. API 키는 PC의 보안 저장소로 암호화하며 저장된 키를 화면으로
          돌려주지 않습니다.
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void saveSettings()}
          disabled={!settingsDirty}
        >
          연결 설정 저장
        </button>
      </fieldset>
      <form
        className="mt-5 space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready && !busy && !settingsDirty && settings.enabled && query.trim()) void search()
        }}
      >
        <label className="block text-sm">
          조회 방식
          <select
            className={`${inputClass} mt-1`}
            value={searchMode}
            disabled={busy}
            onChange={(event) => {
              setSearchMode(event.target.value as MetadataSearchMode)
              setResult(null)
              setCandidate(null)
            }}
          >
            <option value="text">파일명·제목 검색</option>
            <option value="code">작품 코드 (정확히 일치)</option>
          </select>
        </label>
        <label className="block text-sm">
          조회할 파일명 또는 식별자
          <input
            className={`${inputClass} mt-1`}
            maxLength={200}
            value={query}
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value)
              setResult(null)
              setCandidate(null)
            }}
          />
        </label>
        <p className="break-all text-xs text-zinc-400">
          조회 시 위 검색어와 API 인증 정보만 저장한 Stash 서버에 전송합니다. 원본 영상·재생
          기록이나 검색어에 입력하지 않은 파일 경로는 전송하지 않습니다. 후보는 최대 20개이며 자동
          일치를 보장하지 않습니다.
        </p>
        <button
          className="rounded bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={!ready || busy || settingsDirty || !settings.enabled || !query.trim()}
        >
          Stash에서 후보 조회
        </button>
        {settingsDirty && (
          <p className="text-xs text-amber-300">변경한 연결 설정을 먼저 저장하세요.</p>
        )}
      </form>
      {busy && (
        <p role="status" className="mt-3 text-sm">
          처리 중...
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-300">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {result && (
        <section className="mt-4 space-y-2" aria-label="Stash 조회 결과">
          <p className="text-sm">
            {result.total === 0
              ? '일치하는 후보가 없습니다. 검색어를 바꿔보세요.'
              : `후보 ${result.candidates.length}개 표시 (전체 ${result.total}개)`}
          </p>
          {result.candidates.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={busy}
              aria-pressed={candidate?.id === item.id}
              className={`${buttonClass} block w-full text-left`}
              onClick={() => choose(item)}
            >
              <span className="block break-words">{item.title || '(제목 없음)'}</span>
              <span className="block text-xs text-zinc-300">
                {[item.code, item.date, item.studio, `ID ${item.id}`].filter(Boolean).join(' · ')}
              </span>
            </button>
          ))}
        </section>
      )}
      {candidate && (
        <fieldset disabled={busy} className="mt-5 space-y-4 rounded border border-zinc-700 p-4">
          <legend className="px-1 font-medium">적용 전 확인·수정</legend>
          <p className="text-xs text-zinc-400">
            체크한 항목만 교체합니다. 현재 저장된 값을 아래에서 비교하세요. 인물·장르는 전용 필드
            없이 태그로 분류합니다.
          </p>
          {fields.map((key) => (
            <div key={key}>
              <label className="mb-1 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected[key]}
                  onChange={(e) => setSelected({ ...selected, [key]: e.target.checked })}
                />
                {key === 'title'
                  ? '제목 적용'
                  : key === 'memo'
                    ? '설명을 메모에 적용'
                    : '태그 적용'}
              </label>
              <p className="mb-1 max-h-20 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-400">
                현재: {baseline[key] || '(비어 있음)'}
              </p>
              {key === 'memo' ? (
                <textarea
                  className={inputClass}
                  rows={4}
                  aria-label="가져올 메모"
                  maxLength={50_000}
                  value={draft.memo}
                  onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                />
              ) : (
                <input
                  className={inputClass}
                  aria-label={key === 'title' ? '가져올 제목' : '가져올 태그'}
                  maxLength={key === 'title' ? 1000 : 20_000}
                  value={draft[key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              )}
            </div>
          ))}
          <p className="break-words text-xs text-zinc-400">
            Stash 인물: {candidate.people.join(', ') || '(없음)'}
          </p>
          {candidate.people.length > 0 && (
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                setDraft({ ...draft, tags: mergeImportedTags(draft.tags, candidate.people) })
              }
            >
              인물 이름을 태그에 추가
            </button>
          )}
          <p className="text-xs text-zinc-400">
            태그는 쉼표로 구분합니다. 필요한 분류명을 직접 추가할 수 있습니다.
          </p>
          <button
            type="button"
            className="rounded bg-indigo-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={!fields.some((key) => selected[key])}
            onClick={() => void apply()}
          >
            선택한 항목 적용
          </button>
        </fieldset>
      )}
      {undo && (
        <button
          type="button"
          className={`${buttonClass} mt-4`}
          disabled={busy}
          onClick={() => void apply(true)}
        >
          방금 적용 되돌리기
        </button>
      )}
    </dialog>,
    document.body,
  )
}
