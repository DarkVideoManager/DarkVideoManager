import { useState } from 'react'
import { useAppUpdate } from '../../api/useAppUpdate'

export default function AppUpdateNotice() {
  const { api, state, error, run } = useAppUpdate()
  const [dismissed, setDismissed] = useState<string | undefined>()
  if (
    !api ||
    !state ||
    !state.availableVersion ||
    dismissed === state.availableVersion ||
    !(state.phase === 'ready' || (state.mode === 'portable' && state.phase === 'available'))
  )
    return null
  return (
    <aside
      aria-label="새 버전 알림"
      className="flex flex-wrap items-center gap-3 border-b border-indigo-900 bg-indigo-950/50 px-4 py-2 text-sm"
    >
      <p role="status">
        {state.availableVersion}{' '}
        {state.phase === 'ready' ? '업데이트 다운로드가 완료됐습니다.' : '새 버전이 있습니다.'}
      </p>
      <button
        type="button"
        className="rounded bg-indigo-600 px-3 py-1"
        onClick={() =>
          void run(() => (state.phase === 'ready' ? api.install() : api.openRelease()))
        }
      >
        {state.phase === 'ready' ? '재시작하여 업데이트' : '포터블 다운로드'}
      </button>
      <button
        type="button"
        className="rounded px-2 py-1 text-zinc-300"
        onClick={() => setDismissed(state.availableVersion)}
      >
        나중에
      </button>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
    </aside>
  )
}
