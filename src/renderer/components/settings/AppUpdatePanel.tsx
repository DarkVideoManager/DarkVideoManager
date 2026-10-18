import { useAppUpdate } from '../../api/useAppUpdate'

const buttonClass = 'rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600 disabled:opacity-50'

export default function AppUpdatePanel() {
  const { api, state, error, run } = useAppUpdate()
  if (!api) return null
  const supported = state?.mode === 'installer' || state?.mode === 'portable'
  const busy = state && ['checking', 'downloading', 'installing'].includes(state.phase)
  const message = !state
    ? '업데이트 상태를 불러오는 중...'
    : state.phase === 'unsupported'
      ? '설치형 앱에서 자동 업데이트를 사용할 수 있습니다.'
      : state.phase === 'checking'
        ? '새 버전을 확인하고 있습니다.'
        : state.phase === 'up-to-date'
          ? '최신 버전입니다.'
          : state.phase === 'downloading'
            ? `새 버전 다운로드 중${state.progress ? ` (${Math.floor(state.progress.percent)}%)` : '...'}`
            : state.phase === 'ready'
              ? `${state.availableVersion} 버전 설치 준비가 끝났습니다.`
              : state.phase === 'installing'
                ? '작업을 저장하고 업데이트를 적용합니다...'
                : state.phase === 'available'
                  ? `${state.availableVersion} 새 버전이 있습니다.`
                  : state.phase === 'error'
                    ? state.error
                    : '새 버전을 자동으로 확인합니다.'
  return (
    <section
      aria-labelledby="app-update-title"
      className="space-y-3 rounded border border-zinc-700 p-3"
    >
      <h3 id="app-update-title" className="font-semibold">
        앱 업데이트
      </h3>
      {state && (
        <p className="text-xs text-zinc-400">
          현재 버전 {state.currentVersion}
          {state.mode === 'portable' ? ' · 포터블' : state.mode === 'installer' ? ' · 설치형' : ''}
        </p>
      )}
      <p role="status" className="text-sm text-zinc-300">
        {message}
      </p>
      {state?.phase === 'downloading' && state.progress && (
        <progress
          aria-label="업데이트 다운로드"
          max={100}
          value={state.progress.percent}
          className="w-full"
        />
      )}
      {supported && (
        <>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.automatic}
              disabled={state.phase === 'installing'}
              onChange={(event) => void run(() => api.setAutomatic(event.target.checked))}
            />
            {state.mode === 'portable' ? '새 버전 자동 확인' : '자동 확인 및 다운로드'}
          </label>
          <p className="text-xs leading-relaxed text-zinc-400">
            {state.mode === 'portable'
              ? '시작할 때와 6시간마다 새 버전을 확인합니다. 포터블은 새 파일을 다운로드해 교체하세요.'
              : '시작할 때와 6시간마다 확인합니다. 다운로드 후 재시작 버튼을 누르면 진행 중인 작업을 저장하고 적용합니다.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              disabled={!!busy}
              onClick={() => void run(() => api.check())}
            >
              새 버전 확인
            </button>
            {state.mode === 'installer' &&
              state.availableVersion &&
              ['available', 'error'].includes(state.phase) && (
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void run(() => api.download())}
                >
                  업데이트 다운로드
                </button>
              )}
            {state.phase === 'ready' && (
              <button
                type="button"
                className="rounded bg-indigo-600 px-3 py-2"
                onClick={() => void run(() => api.install())}
              >
                재시작하여 업데이트
              </button>
            )}
            <button
              type="button"
              className={buttonClass}
              disabled={state.phase === 'installing'}
              onClick={() => void run(() => api.openRelease())}
            >
              릴리스·직접 다운로드
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  )
}
