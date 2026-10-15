import PlaybackHelpButton from './PlaybackHelpButton'
import * as React from 'react'
import type { Video } from '@shared/types'
import type { usePlayerView } from './usePlayerView'

const buttonClass =
  'rounded bg-white/10 px-2 py-1.5 text-xs text-zinc-100 hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40'

export function PlayerViewControls({
  view,
  enabled,
  isMaximized,
  onToggleMaximized,
  seekStepSec,
  settingsError,
}: {
  view: ReturnType<typeof usePlayerView>
  enabled: boolean
  isMaximized: boolean
  onToggleMaximized: () => void
  seekStepSec: number
  settingsError?: Error | null
}) {
  return (
    <div
      role="group"
      aria-label="영상 보기 도구"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2"
    >
      <PlaybackHelpButton className={buttonClass} />
      <button type="button" className={buttonClass} onClick={onToggleMaximized}>
        {isMaximized ? '상세 보기' : '플레이어 최대화'}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!enabled && !view.isFullscreen}
        onClick={() => void view.toggleFullscreen()}
        title="Alt+Enter · Esc로 전체화면 해제"
      >
        {view.isFullscreen ? '전체화면 해제' : '전체화면'}
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-label="영상 축소"
        title="영상 축소 (-)"
        disabled={!enabled || view.zoom <= 1}
        onClick={() => view.changeZoom(-0.25)}
      >
        −
      </button>
      <span className="min-w-10 text-center text-xs tabular-nums text-zinc-200" aria-live="polite">
        {Math.round(view.zoom * 100)}%
      </span>
      <button
        type="button"
        className={buttonClass}
        aria-label="영상 확대"
        title="영상 확대 (+) · 확대 후 영상을 드래그해 이동"
        disabled={!enabled || view.zoom >= 4}
        onClick={() => view.changeZoom(0.25)}
      >
        +
      </button>
      <button type="button" className={buttonClass} disabled={!enabled} onClick={view.resetZoom}>
        화면 맞춤
      </button>
      <button
        type="button"
        className={buttonClass}
        aria-expanded={view.showInfo}
        title="재생 정보 (I)"
        onClick={() => view.setShowInfo((value) => !value)}
      >
        재생 정보
      </button>
      <span className="text-xs text-zinc-400">
        {enabled
          ? `좌우 이동 ${seekStepSec}초 · 0–9 구간 이동`
          : '전체화면·확대는 외부 플레이어에서 조작하세요.'}
      </span>
      {settingsError && enabled && (
        <span role="status" className="text-xs text-amber-200">
          탐색 설정을 불러오지 못해 {seekStepSec}초를 사용합니다.
        </span>
      )}
    </div>
  )
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
function resolution(width?: number, height?: number) {
  return positive(width) && positive(height) ? `${width} × ${height}` : '정보 없음'
}
function bitrate(value?: number) {
  return positive(value)
    ? value >= 1000
      ? `${(value / 1000).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} Mbps`
      : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} kbps`
    : '정보 없음'
}

export function PlaybackInfo({
  video,
  decodedSize,
  inApp,
  onClose,
}: {
  video: Video
  decodedSize: { width: number; height: number }
  inApp: boolean
  onClose: () => void
}) {
  const rows = [
    ['원본 해상도', resolution(video.width, video.height)],
    [
      '현재 재생 해상도',
      inApp ? resolution(decodedSize.width, decodedSize.height) : '외부 플레이어에서 확인',
    ],
    ['파일 평균 비트레이트', bitrate(video.bitrate)],
    [
      '프레임 속도',
      positive(video.fps)
        ? `${video.fps.toLocaleString('ko-KR', { maximumFractionDigits: 3 })} fps`
        : '정보 없음',
    ],
    ['코덱', video.codec || '정보 없음'],
    [
      '파일 크기',
      positive(video.sizeBytes)
        ? `${(video.sizeBytes / 1024 / 1024).toLocaleString('ko-KR', { maximumFractionDigits: 1 })} MiB`
        : '정보 없음',
    ],
  ]
  return (
    <section
      aria-label="재생 정보"
      className="absolute left-3 top-3 z-30 max-h-[60%] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded border border-zinc-600 bg-black/95 p-3 text-xs text-zinc-200 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="font-semibold">재생 정보</h2>
        <button type="button" className={buttonClass} aria-label="재생 정보 닫기" onClick={onClose}>
          닫기
        </button>
      </div>
      <p className="mb-2 break-all text-zinc-400">{video.fileName}</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-zinc-400">{label}</dt>
            <dd className="break-words">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <p className="mt-3 text-zinc-400">
        비트레이트는 원본 파일의 평균값입니다. 확대 배율과 호환 재생 변환은 원본 정보를 바꾸지
        않습니다.
      </p>
    </section>
  )
}
