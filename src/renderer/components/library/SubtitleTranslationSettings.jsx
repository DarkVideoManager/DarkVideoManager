import * as React from 'react'
import { SubtitlePrivacyGuidance } from './SubtitleGuidance'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const queryKey = ['subtitle-translation-settings']
const characters = (count) => `${count.toLocaleString('ko-KR')}자`
const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

function SettingsForm({ settings }) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = React.useState(settings.enabled)
  const [apiKey, setApiKey] = React.useState('')
  const [monthlyLimit, setMonthlyLimit] = React.useState(String(settings.monthlyLimit))
  const [externalCharacters, setExternalCharacters] = React.useState(
    String(settings.externalCharacters),
  )
  const update = useMutation({
    mutationFn: async (patch) => {
      const result = await window.api.subtitles.updateTranslationSettings(patch)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: (value) => {
      queryClient.setQueryData(queryKey, value)
      setEnabled(value.enabled)
      setMonthlyLimit(String(value.monthlyLimit))
      setExternalCharacters(String(value.externalCharacters))
      setApiKey('')
    },
  })
  const available =
    settings.enabled &&
    settings.hasApiKey &&
    !settings.storageError &&
    settings.remainingCharacters > 0
  const fallbackReason = settings.storageError
    ? '사용량을 확인할 수 없어 Ollama를 사용합니다.'
    : !settings.enabled
      ? 'Cloud Translation이 꺼져 있어 Ollama를 사용합니다.'
      : !settings.hasApiKey
        ? 'API 키가 없어 Ollama를 사용합니다.'
        : '이번 달 사용 한도에 도달해 Ollama를 사용합니다.'
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        update.mutate({
          enabled,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          monthlyLimit: Number(monthlyLimit),
          externalCharacters: Number(externalCharacters),
        })
      }}
    >
      <p aria-label="저장된 번역 경로" className="text-xs text-indigo-200">
        {available
          ? 'Google Cloud Translation 우선 · 남은 한도를 넘는 요청부터 Ollama 사용'
          : fallbackReason}
      </p>
      <dl aria-label="이번 달 번역 사용량" className="grid gap-3 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-zinc-500">이 앱의 사용량 · {settings.month}</dt>
          <dd className="mt-1 text-zinc-200">{characters(settings.usedCharacters)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">외부 사용량 차감</dt>
          <dd className="mt-1 text-zinc-200">{characters(settings.externalCharacters)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">이 앱에서 남은 한도</dt>
          <dd className="mt-1 text-zinc-200">{characters(settings.remainingCharacters)}</dd>
        </div>
      </dl>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        미국 태평양 시간 기준으로 매월 초기화합니다. 응답을 확인하지 못한 요청도 한도에서 차감하므로
        Google의 실제 사용량과 다를 수 있습니다.
      </p>
      <fieldset disabled={update.isPending} className="space-y-3 disabled:opacity-60">
        <label className="flex items-center gap-2 text-xs text-zinc-200">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-indigo-500"
          />
          Google Cloud Translation 사용
        </label>
        <div className="space-y-1">
          <label className="block space-y-1 text-xs text-zinc-400">
            <span>Google Cloud API 키</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                settings.hasApiKey
                  ? '새 키를 입력하면 교체합니다'
                  : 'Google Cloud에서 발급한 API 키'
              }
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
          <p className="text-[11px] text-zinc-500">
            {settings.hasApiKey
              ? 'API 키 저장됨 · 비워 두면 기존 키를 유지합니다.'
              : 'API 키 미등록 · 키를 등록하기 전에는 Ollama를 사용합니다.'}
          </p>
          {settings.hasApiKey && (
            <button
              type="button"
              onClick={() => update.mutate({ removeApiKey: true })}
              className="text-xs text-zinc-400 underline hover:text-zinc-200"
            >
              저장된 API 키 삭제
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-zinc-400">
            <span>월 사용 한도 (자)</span>
            <input
              type="number"
              required
              min="0"
              max="500000"
              step="1"
              value={monthlyLimit}
              onChange={(event) => setMonthlyLimit(event.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
          <label className="space-y-1 text-xs text-zinc-400">
            <span>이번 달 다른 앱·프로젝트 사용량 (자)</span>
            <input
              type="number"
              required
              min="0"
              max="500000"
              step="1"
              value={externalCharacters}
              onChange={(event) => setExternalCharacters(event.target.value)}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
            />
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          월 최대 500,000자 안에서 설정합니다. 다른 앱·프로젝트의 사용량은 자동 조회되지 않으므로
          직접 입력하세요.
        </p>
        <button
          type="submit"
          className="rounded bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-500"
        >
          {update.isPending ? '저장 중...' : '번역 설정 저장'}
        </button>
      </fieldset>
      {update.isSuccess && (
        <p role="status" className="text-xs text-emerald-300">
          번역 설정을 저장했습니다.
        </p>
      )}
      {update.error && (
        <p role="alert" className="break-words text-xs text-red-300">
          설정을 저장하지 못했습니다: {errorMessage(update.error)}
        </p>
      )}
      {settings.storageError && (
        <p role="alert" className="break-words text-xs text-amber-200">
          {settings.storageError}
        </p>
      )}
    </form>
  )
}

export default function SubtitleTranslationSettings() {
  const settings = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await window.api.subtitles.getTranslationSettings()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    refetchInterval: 5000,
    refetchOnMount: 'always',
    retry: false,
  })
  return (
    <section
      aria-label="한국어 번역 설정"
      className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
    >
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-zinc-100">한국어 번역 설정</h2>
        <p className="text-xs leading-relaxed text-zinc-400">
          기본은 PC의 Ollama 번역입니다. Google Cloud 사용을 켜고 API 키를 저장하면 자막 텍스트를
          Google에 보내 번역합니다. 키가 없거나 월 한도에 도달하거나 요청이 실패하면 로컬로
          전환합니다.
        </p>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Google Cloud에서 결제 계정 연결, Cloud Translation API 활성화 및 API 키 발급이 필요합니다.
          월 500,000자 무료 범위는 결제 계정의 다른 Translation 사용량과 공유합니다. 이 앱의 한도
          설정은 Google 계정 전체의 과금을 차단하지 않습니다.
        </p>
      </div>
      <SubtitlePrivacyGuidance />
      {settings.isPending && (
        <p role="status" className="text-xs text-zinc-400">
          번역 설정을 불러오는 중...
        </p>
      )}
      {settings.error && (
        <div className="space-y-2 text-xs text-red-300">
          <p role="alert">번역 설정을 불러오지 못했습니다: {errorMessage(settings.error)}</p>
          <button type="button" onClick={() => void settings.refetch()} className="underline">
            번역 설정 다시 확인
          </button>
        </div>
      )}
      {settings.data && <SettingsForm key={settings.data.month} settings={settings.data} />}
    </section>
  )
}
