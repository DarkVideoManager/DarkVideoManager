import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PrivacySettingsZ, type PrivacySettings } from '@shared/privacy'
import { usePrivacySettings } from './PrivacyBoundary'

export default function PrivacySettingsPanel() {
  const query = usePrivacySettings()
  const client = useQueryClient()
  const [draft, setDraft] = useState<PrivacySettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (query.data) setDraft(query.data)
  }, [query.data])
  async function save() {
    if (!draft || busy) return
    const parsed = PrivacySettingsZ.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0].message)
      return
    }
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      const result = await window.api.privacy.save(parsed.data)
      if (!result.ok) throw new Error(result.error)
      client.setQueryData(['privacy-settings'], result.value)
      setNotice('화면 보호 설정을 저장했습니다.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="화면 보호" className="space-y-3 border-t border-zinc-700 pt-4">
      <h3 className="font-semibold">화면 보호</h3>
      {query.isPending && <p>화면 보호 설정을 불러오는 중...</p>}
      {query.error && (
        <div>
          <p role="alert">{query.error.message}</p>
          <button type="button" onClick={() => void query.refetch()}>
            화면 보호 설정 다시 읽기
          </button>
        </div>
      )}
      {draft && (
        <fieldset disabled={busy} className="space-y-3 disabled:opacity-50">
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={draft.maskThumbnails}
              onChange={(event) => setDraft({ ...draft, maskThumbnails: event.target.checked })}
            />
            목록 썸네일을 대체 화면으로 가리기
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              disabled={!draft.maskThumbnails}
              checked={draft.revealOnHover}
              onChange={(event) => setDraft({ ...draft, revealOnHover: event.target.checked })}
            />
            마우스를 올리거나 키보드로 선택하면 원본 표시
          </label>
          <p className="text-xs text-zinc-400">
            목록의 썸네일만 가립니다. 제목·메모·상세 이미지와 재생 화면은 그대로 표시됩니다.
          </p>
          <label className="block">
            긴급 탈출 후 화면
            <select
              aria-label="긴급 탈출 후 화면"
              value={draft.exitAction}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  exitAction: event.target.value as PrivacySettings['exitAction'],
                })
              }
              className="ml-2 rounded bg-zinc-800 p-2"
            >
              <option value="close">앱 창 닫기 (기존 동작)</option>
              <option value="blank">가림 화면 표시</option>
              <option value="website">가림 화면과 지정 웹페이지 열기</option>
            </select>
          </label>
          {draft.exitAction === 'website' && (
            <label className="block">
              탈출 후 웹 주소
              <input
                type="url"
                value={draft.exitUrl}
                onChange={(event) => setDraft({ ...draft, exitUrl: event.target.value })}
                placeholder="https://example.com"
                className="mt-1 w-full rounded bg-zinc-800 p-2"
              />
              <span className="text-xs text-zinc-400">
                탈출할 때 기본 브라우저로 엽니다. 해당 사이트에 접속 기록이 남을 수 있습니다.
              </span>
            </label>
          )}
          <p className="text-xs text-zinc-400">
            앱에 초점이 있을 때 Ctrl+Shift+H 또는 상단 화면 숨기기를 사용하세요. 목록·자막 대기열의
            Esc에도 적용됩니다. 플레이어의 Esc는 목록으로 돌아갑니다. 자막 작업은 계속됩니다. 이미
            별도로 실행 중인 외부 플레이어 창은 직접 확인하세요.
          </p>
          <button
            type="button"
            onClick={() => void save()}
            className="rounded bg-indigo-700 px-3 py-2"
          >
            {busy ? '화면 보호 저장 중...' : '화면 보호 설정 저장'}
          </button>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
