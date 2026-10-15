import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const queryKey = ['subtitle-environment-setup']
const activePhases = new Set(['checking', 'installing'])
const phaseLabels = {
  idle: '설치 준비',
  checking: '환경 확인 중',
  installing: '설치 중',
  ready: '사용 준비 완료',
  cancelled: '설치 취소됨',
  failed: '설치 확인 필요',
  'restart-required': 'Windows 재시작 필요',
}
const stateLabels = {
  checking: '확인 중',
  missing: '설치 필요',
  installing: '준비 중',
  ready: '준비됨',
  failed: '확인 필요',
}
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))
const elapsedLabel = (milliseconds) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
}

export default function SubtitleEnvironmentSetup() {
  const queryClient = useQueryClient()
  const readyVersion = React.useRef(null)
  const status = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await window.api.subtitles.getSetupStatus()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => (activePhases.has(query.state.data?.phase) ? 1000 : false),
    refetchIntervalInBackground: true,
    retry: false,
  })
  const action = useMutation({
    mutationFn: async (operation) => {
      await queryClient.cancelQueries({ queryKey, exact: true })
      const result = await window.api.subtitles[operation]()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: (value) => {
      if (typeof value === 'object' && value !== null) queryClient.setQueryData(queryKey, value)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey, exact: true }),
  })
  const setup = status.data
  const phase = setup?.phase
  const updatedAt = setup?.updatedAt
  const active = activePhases.has(phase)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [active, setup?.stepStartedAt])
  const currentComponent = setup?.components.find((item) => item.id === setup.currentComponent)
  const stepStartedAt = Date.parse(setup?.stepStartedAt || '')
  const lastUpdate = Date.parse(updatedAt || '')
  const waitingForUpdate = active && Number.isFinite(lastUpdate) && now - lastUpdate >= 120_000
  const busy = action.isPending || active
  const error = action.error || status.error
  React.useEffect(() => {
    if (phase !== 'ready') {
      readyVersion.current = null
      return
    }
    if (readyVersion.current === updatedAt) return
    readyVersion.current = updatedAt
    void queryClient.invalidateQueries({ queryKey: ['subtitle-engine'] })
  }, [phase, updatedAt, queryClient])

  return (
    <section
      id="subtitle-environment"
      aria-label="자막 환경 자동 설치"
      className="scroll-mt-4 space-y-4 rounded-lg border border-zinc-700 bg-zinc-900/60 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-zinc-100">자막 환경 자동 설치</h2>
          <p className="text-xs leading-relaxed text-zinc-400">
            음성 인식과 PC 한국어 번역에 필요한 프로그램·모델을 한 번에 준비합니다.
          </p>
        </div>
        {phase && (
          <span
            className={`text-xs ${phase === 'ready' ? 'text-emerald-300' : phase === 'failed' || phase === 'restart-required' ? 'text-amber-200' : 'text-indigo-300'}`}
          >
            {phaseLabels[phase] || phaseLabels.idle}
          </span>
        )}
      </div>
      <div className="space-y-1 text-xs leading-relaxed text-zinc-400">
        <p>
          처음 설치할 때 인터넷 연결과 수 GB 다운로드가 필요합니다. 여유 공간은 15GB 이상을
          권장합니다.
        </p>
        <p>
          Windows에서 관리자 승인이나 재시작을 요청할 수 있습니다. 재시작 후 이 화면에서 설치를
          이어가세요.
        </p>
        <p>Windows 안내에 따라 Ubuntu의 초기 설정이 필요할 수도 있습니다.</p>
      </div>
      {status.isPending && (
        <p role="status" className="text-xs text-zinc-400">
          자막 환경 상태를 불러오는 중...
        </p>
      )}
      {setup?.message && (
        <p
          role={phase === 'failed' ? 'alert' : 'status'}
          aria-live="polite"
          className={`break-words text-xs leading-relaxed ${phase === 'ready' ? 'text-emerald-300' : phase === 'failed' || phase === 'restart-required' ? 'text-amber-200' : 'text-zinc-300'}`}
        >
          {setup.message}
        </p>
      )}
      {active && currentComponent && Number.isFinite(stepStartedAt) && (
        <p aria-label="설치 단계 경과" className="text-xs leading-relaxed text-indigo-200">
          현재 단계: {currentComponent.label} · 경과 {elapsedLabel(now - stepStartedAt)}
        </p>
      )}
      {waitingForUpdate && (
        <p className="text-xs leading-relaxed text-amber-200">
          {elapsedLabel(now - lastUpdate)} 동안 새 진행 안내가 없습니다. 권한 승인 창과 인터넷
          연결을 확인해 주세요. Windows 설치 중에는 앱을 종료해도 설치가 계속될 수 있습니다.
        </p>
      )}
      {!!setup?.components.length && (
        <ul aria-label="자막 환경 준비 상태" className="grid gap-2 sm:grid-cols-2">
          {setup.components.map((component) => {
            const percent =
              typeof component.percent === 'number'
                ? Math.max(0, Math.min(100, Math.round(component.percent)))
                : null
            return (
              <li key={component.id} className="space-y-1 rounded bg-zinc-950/50 px-3 py-2">
                <div className="flex items-start justify-between gap-2 text-xs">
                  <span className="text-zinc-300">{component.label}</span>
                  <span
                    className={`shrink-0 ${component.state === 'ready' ? 'text-emerald-300' : component.state === 'failed' ? 'text-amber-200' : 'text-zinc-400'}`}
                  >
                    {component.state === 'checking'
                      ? !active
                        ? '확인 전'
                        : setup.currentComponent && component.id !== setup.currentComponent
                          ? '대기 중'
                          : stateLabels.checking
                      : stateLabels[component.state] || stateLabels.checking}
                    {component.state === 'installing' && percent !== null ? ` · ${percent}%` : ''}
                  </span>
                </div>
                {component.message && (
                  <p className="break-words text-[11px] leading-relaxed text-zinc-500">
                    {component.message}
                  </p>
                )}
                {component.state === 'installing' && (
                  <progress
                    aria-label={`${component.label} 설치 진행률`}
                    max={100}
                    {...(percent === null ? {} : { value: percent })}
                    className="h-1.5 w-full accent-indigo-500"
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {phase === 'restart-required' && (
        <p className="text-xs leading-relaxed text-amber-200">
          열어 둔 작업을 저장하고 Windows를 재시작한 뒤, 앱을 다시 열어 ‘설치 이어서 진행’을
          누르세요.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {phase !== 'ready' && (
          <button
            type="button"
            onClick={() => action.mutate('startSetup')}
            disabled={busy || status.isPending}
            className="rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {action.isPending && action.variables === 'startSetup'
              ? '설치 시작 중...'
              : phase === 'installing'
                ? '자막 환경 설치 중...'
                : phase === 'failed'
                  ? '설치 다시 시도'
                  : phase === 'cancelled' || phase === 'restart-required'
                    ? '설치 이어서 진행'
                    : '자막 환경 자동 설치'}
          </button>
        )}
        <button
          type="button"
          onClick={() => action.mutate('checkSetup')}
          disabled={busy || status.isPending}
          className="rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {phase === 'checking' || (action.isPending && action.variables === 'checkSetup')
            ? '환경 확인 중...'
            : '환경 다시 확인'}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => action.mutate('cancelSetup')}
            disabled={action.isPending || setup?.canCancel === false}
            className="rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {action.isPending && action.variables === 'cancelSetup'
              ? '취소 요청 중...'
              : '설치 취소'}
          </button>
        )}
      </div>
      {active && setup?.canCancel === false && (
        <p className="text-xs leading-relaxed text-zinc-400">
          현재 단계에서는 취소 버튼을 사용할 수 없습니다. 진행 중인 단계가 끝날 때까지 기다려
          주세요.
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-red-300">
          {errorMessage(error)}
        </p>
      )}
    </section>
  )
}
