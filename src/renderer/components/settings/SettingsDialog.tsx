import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AccelerationInfo, AppSettings, CacheInfo, NativePlayerInfo } from '@shared/types'
import PlaybackHelpButton from '../player/PlaybackHelpButton'
import AppUpdatePanel from './AppUpdatePanel'

import {
  DEFAULT_SEEK_STEP_SEC,
  MAX_SEEK_STEP_SEC,
  MIN_SEEK_STEP_SEC,
  SeekStepSecZ,
} from '@shared/playerSettings'
import PrivacySettingsPanel from '../privacy/PrivacySettingsPanel'
import { SubtitlePrivacyGuidance } from '../library/SubtitleGuidance'

interface SettingsDialogProps {
  onClose: () => void
}

type AccelerationState =
  | { status: 'loading' }
  | { status: 'loaded'; info: AccelerationInfo }
  | { status: 'error'; message: string }

function accelerationLabel(status: string): string {
  const value = status.trim().toLowerCase()
  if (value.startsWith('enabled')) return '하드웨어 가속 사용 가능'
  if (value.includes('software')) return '소프트웨어 처리'
  if (value === 'off' || value.includes('_off')) return '사용 불가'
  return '상태 미확인'
}

const GB = 1024 ** 3

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} GB`
  if (bytes >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} KB`
  return `${bytes.toLocaleString('ko-KR')} B`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function playerKey(player: NativePlayerInfo | null | undefined): string {
  return player ? `${player.name}:${player.path}` : 'auto'
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const queryClient = useQueryClient()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cleanupButtonRef = useRef<HTMLButtonElement>(null)
  const cancelCleanupRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null)
  const [limitInput, setLimitInput] = useState('')
  const [seekStepInput, setSeekStepInput] = useState('')
  const [selectedNative, setSelectedNative] = useState<NativePlayerInfo | null>(null)
  const [nativePlayers, setNativePlayers] = useState<NativePlayerInfo[]>([])
  const [manualPlayerName, setManualPlayerName] = useState<NativePlayerInfo['name']>('mpv')
  const [playersLoading, setPlayersLoading] = useState(true)
  const [playersError, setPlayersError] = useState<string | null>(null)
  const [playersVersion, setPlayersVersion] = useState(0)
  const [acceleration, setAcceleration] = useState<AccelerationState>({ status: 'loading' })
  const [accelerationVersion, setAccelerationVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadVersion, setLoadVersion] = useState(0)
  const [operation, setOperation] = useState<'save' | 'cleanup' | 'select-native' | null>(null)
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const busy = operation !== null
  const limit = Number(limitInput)
  const validLimit =
    limitInput.trim() !== '' && Number.isFinite(limit) && limit >= 1 && limit <= 1000
  const cacheChanged = settings !== null && limit !== settings.cacheLimitGb
  const seekStep = Number(seekStepInput)
  const validSeekStep = seekStepInput.trim() !== '' && SeekStepSecZ.safeParse(seekStep).success
  const seekStepChanged =
    settings !== null && seekStep !== (settings.seekStepSec ?? DEFAULT_SEEK_STEP_SEC)
  const nativeChanged =
    settings !== null && playerKey(selectedNative) !== playerKey(settings.nativePlayer)
  const changed = cacheChanged || nativeChanged || seekStepChanged
  const playerOptions = [...nativePlayers]
  if (
    selectedNative &&
    !playerOptions.some((player) => playerKey(player) === playerKey(selectedNative))
  ) {
    playerOptions.push(selectedNative)
  }

  useEffect(() => {
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [settingsResult, cacheResult] = await Promise.all([
          window.api.app.getSettings(),
          window.api.app.getCacheInfo(),
        ])
        if (!settingsResult.ok) throw new Error(settingsResult.error)
        if (!cacheResult.ok) throw new Error(cacheResult.error)
        if (!active) return
        setSettings(settingsResult.value)
        setSelectedNative(settingsResult.value.nativePlayer ?? null)
        setLimitInput(String(settingsResult.value.cacheLimitGb))
        setSeekStepInput(String(settingsResult.value.seekStepSec ?? DEFAULT_SEEK_STEP_SEC))
        setCacheInfo(cacheResult.value)
      } catch (cause) {
        if (active) setError(errorMessage(cause))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [loadVersion])

  useEffect(() => {
    let active = true
    setPlayersLoading(true)
    setPlayersError(null)
    void (async () => {
      try {
        const result = await window.api.app.getNativePlayers()
        if (!result.ok) throw new Error(result.error)
        if (active) setNativePlayers(result.value)
      } catch (cause) {
        if (active) setPlayersError(errorMessage(cause))
      } finally {
        if (active) setPlayersLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [playersVersion])

  useEffect(() => {
    let active = true
    setAcceleration({ status: 'loading' })
    void (async () => {
      try {
        const result = await window.api.app.getAccelerationInfo()
        if (!result.ok) throw new Error(result.error)
        if (active) setAcceleration({ status: 'loaded', info: result.value })
      } catch (cause) {
        if (active) setAcceleration({ status: 'error', message: errorMessage(cause) })
      }
    })()
    return () => {
      active = false
    }
  }, [accelerationVersion])

  useEffect(() => {
    if (confirmCleanup) cancelCleanupRef.current?.focus()
    else if (wasConfirming.current) cleanupButtonRef.current?.focus()
    wasConfirming.current = confirmCleanup
  }, [confirmCleanup])

  async function saveSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy || !validLimit || !validSeekStep || !changed) return
    setOperation('save')
    setError(null)
    setNotice(null)
    try {
      const patch: Partial<AppSettings> = {}
      if (cacheChanged) patch.cacheLimitGb = limit
      if (seekStepChanged) patch.seekStepSec = seekStep
      if (nativeChanged) patch.nativePlayer = selectedNative
      const result = await window.api.app.updateSettings(patch)
      if (!result.ok) throw new Error(result.error)
      setSettings(result.value)
      setLimitInput(String(result.value.cacheLimitGb))
      setSeekStepInput(String(result.value.seekStepSec ?? DEFAULT_SEEK_STEP_SEC))
      setSelectedNative(result.value.nativePlayer ?? null)
      setCacheInfo((previous) =>
        previous ? { ...previous, limitBytes: result.value.cacheLimitGb * GB } : previous,
      )
      setNotice(
        seekStepChanged
          ? cacheChanged || nativeChanged
            ? '설정을 저장했습니다.'
            : '탐색 간격을 저장했습니다.'
          : nativeChanged
            ? cacheChanged
              ? '캐시와 외부 플레이어 설정을 저장했습니다.'
              : '외부 플레이어 설정을 저장했습니다.'
            : '캐시 용량 상한을 저장했습니다.',
      )
      queryClient.setQueryData(['app-settings'], result.value)
      if (nativeChanged) await queryClient.invalidateQueries({ queryKey: ['native-player-info'] })
      try {
        const infoResult = await window.api.app.getCacheInfo()
        if (!infoResult.ok) throw new Error(infoResult.error)
        setCacheInfo(infoResult.value)
      } catch (cause) {
        setError(`설정은 저장했지만 캐시 사용량을 불러오지 못했습니다: ${errorMessage(cause)}`)
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setOperation(null)
    }
  }

  async function selectNativePlayer(): Promise<void> {
    if (busy) return
    setOperation('select-native')
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.app.selectNativePlayer(manualPlayerName)
      if (!result.ok) throw new Error(result.error)
      if (result.value) setSelectedNative(result.value)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setOperation(null)
    }
  }

  async function cleanCache(): Promise<void> {
    if (busy) return
    setOperation('cleanup')
    setError(null)
    setNotice(null)
    try {
      const result = await window.api.app.cleanCache()
      if (!result.ok) throw new Error(result.error)
      setCacheInfo(result.value.info)
      setNotice(
        `캐시 파일 ${result.value.removedFiles.toLocaleString('ko-KR')}개, ${formatBytes(result.value.removedBytes)}를 정리했습니다.`,
      )
      setConfirmCleanup(false)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setOperation(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="settings-title"
      className="m-auto max-h-[90vh] w-[min(36rem,calc(100vw-2rem))] max-w-none overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/70"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (!first) {
          event.preventDefault()
          event.currentTarget.focus()
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault()
          last.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault()
          first.focus()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        if (busy) return
        if (confirmCleanup) setConfirmCleanup(false)
        else onClose()
      }}
    >
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 px-5 py-4">
        <h2 id="settings-title" className="text-lg font-semibold">
          설정
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          닫기
        </button>
      </div>
      <div className="space-y-5 p-5 text-sm">
        <AppUpdatePanel />
        <section aria-label="재생 조작 도움말" className="rounded border border-zinc-700 p-3">
          <p className="mb-2 text-zinc-400">
            왼손 조작, 음량, 화면 크기와 현재 지원하는 단축키를 확인하세요.
          </p>
          <PlaybackHelpButton label="단축키·재생 조작 안내" />
        </section>
        <SubtitlePrivacyGuidance />
        {loading && (
          <p role="status" className="text-zinc-400">
            설정을 불러오는 중...
          </p>
        )}
        {error && (
          <p role="alert" className="break-words rounded bg-red-950/50 p-3 text-red-300">
            {error}
          </p>
        )}
        {!loading && (!settings || !cacheInfo) && (
          <button
            type="button"
            onClick={() => setLoadVersion((value) => value + 1)}
            className="rounded bg-zinc-700 px-3 py-2"
          >
            다시 시도
          </button>
        )}
        <PrivacySettingsPanel />
        {settings && cacheInfo && (
          <form onSubmit={(event) => void saveSettings(event)} noValidate className="space-y-5">
            <section aria-labelledby="seek-step-title" className="space-y-3">
              <h3 id="seek-step-title" className="font-semibold">
                재생 탐색
              </h3>
              <p aria-label="현재 적용된 탐색 간격" className="text-xs text-zinc-300">
                현재 적용: {settings.seekStepSec ?? DEFAULT_SEEK_STEP_SEC}초
              </p>
              <div>
                <label htmlFor="seek-step" className="mb-2 block font-medium">
                  기본 탐색 간격 (초)
                </label>
                <input
                  id="seek-step"
                  type="number"
                  min={MIN_SEEK_STEP_SEC}
                  max={MAX_SEEK_STEP_SEC}
                  step={1}
                  value={seekStepInput}
                  disabled={busy || confirmCleanup}
                  aria-describedby="seek-step-help seek-step-shortcuts"
                  aria-invalid={!validSeekStep}
                  onChange={(event) => {
                    setSeekStepInput(event.target.value)
                    setNotice(null)
                  }}
                  className="w-32 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 disabled:opacity-50"
                />
                <p
                  id="seek-step-help"
                  className={`mt-2 text-xs ${validSeekStep ? 'text-zinc-400' : 'text-amber-300'}`}
                >
                  {MIN_SEEK_STEP_SEC}~{MAX_SEEK_STEP_SEC}초의 정수로 입력하세요. 기본값은{' '}
                  {DEFAULT_SEEK_STEP_SEC}초입니다. 저장 후 적용됩니다.
                </p>
              </div>
              <p id="seek-step-shortcuts" className="text-xs leading-relaxed text-zinc-400">
                ←/→ 및 A/D를 한 번 누를 때 적용됩니다. 인앱 플레이어는 저장 즉시, mpv는 다음
                실행부터 적용됩니다. Shift 조합은 5초, Ctrl 조합은 30초와 기존 길게 누르기 가속을
                유지합니다. ffplay·VLC는 자체 단축키 설정을 사용합니다.
              </p>
            </section>
            <section aria-labelledby="cache-title" className="space-y-3">
              <h3 id="cache-title" className="font-semibold">
                재생 캐시
              </h3>
              <div className="rounded-lg border border-zinc-700 bg-zinc-950/50 p-4">
                <p className="text-zinc-400">사용량 / 용량 상한</p>
                <p className="mt-1 text-xl font-semibold" data-testid="cache-usage">
                  {formatBytes(cacheInfo.usedBytes)} / {formatBytes(cacheInfo.limitBytes)}
                </p>
                <div
                  role="progressbar"
                  aria-label="재생 캐시 사용률"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(
                    100,
                    Math.round((cacheInfo.usedBytes / Math.max(1, cacheInfo.limitBytes)) * 100),
                  )}
                  className="my-3 h-2 overflow-hidden rounded bg-zinc-800"
                >
                  <div
                    className="h-full bg-indigo-400"
                    style={{
                      width: `${Math.min(100, (cacheInfo.usedBytes / Math.max(1, cacheInfo.limitBytes)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-zinc-400">
                  파일 {cacheInfo.fileCount.toLocaleString('ko-KR')}개 · 사용 중인 보호 캐시{' '}
                  {formatBytes(cacheInfo.protectedBytes)}
                </p>
              </div>
              <div>
                <label htmlFor="cache-limit" className="mb-2 block font-medium">
                  캐시 용량 상한 (GB)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="cache-limit"
                    type="number"
                    min={1}
                    max={1000}
                    step="any"
                    value={limitInput}
                    disabled={busy || confirmCleanup}
                    aria-describedby="cache-limit-help"
                    aria-invalid={!validLimit}
                    onChange={(event) => {
                      setLimitInput(event.target.value)
                      setNotice(null)
                    }}
                    className="w-32 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 disabled:opacity-50"
                  />
                </div>
                <p
                  id="cache-limit-help"
                  className={`mt-2 text-xs ${validLimit ? 'text-zinc-400' : 'text-amber-300'}`}
                >
                  1~1000 GB 범위로 입력하세요.
                </p>
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                재생 또는 변환 중인 파일은 보호됩니다. 보호된 캐시로 인해 용량 상한을 일시적으로
                초과할 수 있습니다.
              </p>
            </section>
            <section
              aria-labelledby="acceleration-title"
              className="space-y-3 border-t border-zinc-700 pt-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 id="acceleration-title" className="font-semibold">
                  인앱 재생 가속
                </h3>
                <button
                  type="button"
                  disabled={acceleration.status === 'loading'}
                  onClick={() => setAccelerationVersion((value) => value + 1)}
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                >
                  다시 확인
                </button>
              </div>
              <div aria-live="polite">
                {acceleration.status === 'loading' && (
                  <p className="text-xs text-zinc-400">가속 상태 확인 중...</p>
                )}
                {acceleration.status === 'error' && (
                  <p className="break-words text-xs text-amber-300">
                    가속 상태를 확인하지 못했습니다. {acceleration.message}
                  </p>
                )}
                {acceleration.status === 'loaded' && (
                  <dl className="space-y-2 text-xs">
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <dt className="text-zinc-400">동영상 디코딩</dt>
                      <dd data-testid="video-decode-status">
                        {accelerationLabel(acceleration.info.videoDecodeStatus)}
                      </dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <dt className="text-zinc-400">화면 합성</dt>
                      <dd data-testid="gpu-compositing-status">
                        {accelerationLabel(acceleration.info.gpuCompositingStatus)}
                      </dd>
                    </div>
                  </dl>
                )}
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">
                실제 GPU 사용 여부는 영상 형식에 따라 달라집니다.
              </p>
            </section>
            <section
              aria-labelledby="native-player-title"
              className="space-y-3 border-t border-zinc-700 pt-4"
            >
              <h3 id="native-player-title" className="font-semibold">
                외부 플레이어
              </h3>
              <div className="rounded border border-zinc-700 bg-zinc-950/50 p-3 text-xs">
                <p className="text-zinc-400">현재 설정</p>
                <p data-testid="saved-native-player" className="mt-1 break-all">
                  {settings.nativePlayer
                    ? `${settings.nativePlayer.name} · ${settings.nativePlayer.path}`
                    : '자동 선택'}
                </p>
              </div>
              <label htmlFor="native-player-choice" className="block font-medium">
                재생에 사용할 외부 플레이어
              </label>
              <select
                id="native-player-choice"
                value={playerKey(selectedNative)}
                disabled={busy || confirmCleanup}
                onChange={(event) => {
                  setSelectedNative(
                    playerOptions.find((player) => playerKey(player) === event.target.value) ??
                      null,
                  )
                  setNotice(null)
                }}
                className="w-full min-w-0 rounded border border-zinc-600 bg-zinc-950 px-3 py-2 disabled:opacity-50"
              >
                <option value="auto">자동 선택 (mpv 우선)</option>
                {playerOptions.map((player) => (
                  <option key={playerKey(player)} value={playerKey(player)}>
                    {player.name} · {player.path}
                  </option>
                ))}
              </select>
              {selectedNative && (
                <p className="break-all text-xs text-zinc-400">
                  선택한 실행 파일: {selectedNative.path}
                </p>
              )}
              <p className="text-xs leading-relaxed text-zinc-400">
                자동 선택은 설치된 플레이어 중 mpv를 우선 사용합니다. 기본 설치 위치와 PATH에서
                발견한 플레이어를 선택하거나 실행 파일을 직접 지정할 수 있습니다.
              </p>
              {playersLoading && (
                <p className="text-xs text-zinc-400">설치된 플레이어를 찾는 중...</p>
              )}
              {playersError && (
                <div className="space-y-2">
                  <p role="alert" className="break-words text-xs text-red-300">
                    {playersError}
                  </p>
                  <button
                    type="button"
                    disabled={busy || confirmCleanup}
                    onClick={() => setPlayersVersion((value) => value + 1)}
                    className="rounded bg-zinc-700 px-3 py-2 disabled:opacity-50"
                  >
                    플레이어 다시 검색
                  </button>
                </div>
              )}
              {!playersLoading && !playersError && nativePlayers.length === 0 && (
                <p className="text-xs text-amber-300">
                  자동으로 발견한 플레이어가 없습니다. 실행 파일을 직접 선택하세요.
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="manual-player-name" className="mb-2 block text-xs">
                    직접 지정할 플레이어
                  </label>
                  <select
                    id="manual-player-name"
                    value={manualPlayerName}
                    disabled={busy || confirmCleanup}
                    onChange={(event) =>
                      setManualPlayerName(event.target.value as NativePlayerInfo['name'])
                    }
                    className="rounded border border-zinc-600 bg-zinc-950 px-3 py-2 disabled:opacity-50"
                  >
                    <option value="mpv">mpv</option>
                    <option value="ffplay">ffplay</option>
                    <option value="vlc">VLC</option>
                  </select>
                </div>
                <button
                  type="button"
                  disabled={busy || confirmCleanup}
                  onClick={() => void selectNativePlayer()}
                  className="rounded border border-zinc-600 px-3 py-2 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {operation === 'select-native' ? '실행 파일 선택 중...' : '실행 파일 선택'}
                </button>
              </div>
              <p className="text-xs text-zinc-400">변경사항은 저장을 누른 후 적용됩니다.</p>
              <button
                type="submit"
                disabled={busy || confirmCleanup || !validLimit || !validSeekStep || !changed}
                className="rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500 disabled:opacity-50"
              >
                {operation === 'save' ? '저장 중...' : '저장'}
              </button>
            </section>
            <section
              aria-labelledby="cache-cleanup-title"
              className="space-y-3 border-t border-zinc-700 pt-4"
            >
              <h3 id="cache-cleanup-title" className="font-semibold">
                사용하지 않는 캐시 정리
              </h3>
              <p className="text-xs leading-relaxed text-zinc-400">
                사용하지 않는 재생·변환 캐시만 정리합니다. 원본 동영상과 캡처 이미지는 보존됩니다.
              </p>
              {!confirmCleanup ? (
                <button
                  ref={cleanupButtonRef}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmCleanup(true)
                    setError(null)
                    setNotice(null)
                  }}
                  className="rounded border border-zinc-600 px-3 py-2 hover:bg-zinc-800 disabled:opacity-50"
                >
                  사용하지 않는 캐시 정리
                </button>
              ) : (
                <div className="space-y-3 rounded-lg border border-amber-800 bg-amber-950/20 p-3">
                  <p className="text-amber-200">사용하지 않는 캐시를 정리할까요?</p>
                  <p className="text-xs text-zinc-400">
                    정리된 캐시가 필요하면 다음 재생 때 다시 생성됩니다.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      ref={cancelCleanupRef}
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmCleanup(false)}
                      className="rounded bg-zinc-700 px-3 py-2 disabled:opacity-50"
                    >
                      취소
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void cleanCache()}
                      className="rounded bg-amber-700 px-3 py-2 disabled:opacity-50"
                    >
                      {operation === 'cleanup' ? '정리 중...' : '캐시 정리 확인'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </form>
        )}
        {notice && (
          <p role="status" className="break-words rounded bg-emerald-950/40 p-3 text-emerald-300">
            {notice}
          </p>
        )}
      </div>
    </dialog>
  )
}
