import { useEffect, useRef, useState } from 'react'
import type { Result } from '../../../shared/result'

export default function GitHubStarNotice() {
  const capability = window.api.app.githubStar
  const claim = useRef<Promise<Result<boolean, string>>>()
  const [visible, setVisible] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!capability) return
    let active = true
    // React StrictMode repeats effects. Share this mount's request so it cannot
    // consume the persisted first-run flag before the visible effect receives it.
    claim.current ??= Promise.resolve().then(() => capability.claimPrompt())
    void claim.current
      .then((result) => {
        if (active && result.ok) setVisible(result.value)
      })
      .catch(() => {
        // A settings failure must not interrupt library access or create a loop.
      })
    return () => {
      active = false
    }
  }, [capability])

  async function openRepository() {
    if (!capability || opening) return
    setOpening(true)
    setError(false)
    try {
      const result = await capability.openRepository()
      if (!result.ok) throw new Error(result.error)
      setVisible(false)
    } catch {
      setError(true)
    } finally {
      setOpening(false)
    }
  }

  if (!visible) return null

  return (
    <section
      aria-label="GitHub Star 안내"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-indigo-900 bg-indigo-950/40 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">
          프로그램이 도움이 되었다면 GitHub에서 Star를 눌러주세요.
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          저장소 페이지에서 직접 누를 수 있습니다. 이 안내는 한 번만 표시됩니다.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-xs text-amber-300">
            브라우저를 열지 못했습니다. 다시 시도하거나 안내를 닫고 계속 사용할 수 있습니다.
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => void openRepository()}
          disabled={opening}
          className="rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {opening ? '브라우저 여는 중…' : 'GitHub에서 Star 누르기'}
        </button>
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          닫기
        </button>
      </div>
    </section>
  )
}
