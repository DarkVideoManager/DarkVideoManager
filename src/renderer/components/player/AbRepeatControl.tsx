function positionLabel(value: number | null): string {
  if (value === null) return '--:--'
  const hundredths = Math.round(value * 100)
  const hours = Math.floor(hundredths / 360000)
  const minutes = Math.floor((hundredths % 360000) / 6000)
  const seconds = Math.floor((hundredths % 6000) / 100)
  return `${hours > 0 ? `${hours}:` : ''}${hours > 0 ? String(minutes).padStart(2, '0') : minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`
}

const buttonClass =
  'rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40'

export default function AbRepeatControl({
  start,
  end,
  enabled,
  available,
  external,
  error,
  onMark,
  onToggle,
  onClear,
}: {
  start: number | null
  end: number | null
  enabled: boolean
  available: boolean
  external: boolean
  error: string | null
  onMark(point: 'start' | 'end'): void
  onToggle(): void
  onClear(): void
}) {
  return (
    <div
      role="group"
      aria-label="A-B 구간 반복"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
    >
      <span className="font-medium">구간 반복</span>
      <button
        type="button"
        className={buttonClass}
        disabled={!available}
        aria-label="A 시작점 설정"
        onClick={() => onMark('start')}
      >
        A {positionLabel(start)}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!available}
        aria-label="B 끝점 설정"
        onClick={() => onMark('end')}
      >
        B {positionLabel(end)}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={!available}
        aria-pressed={enabled}
        onClick={onToggle}
      >
        {enabled ? '반복 끄기' : '반복 켜기'}
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={start === null && end === null && !error}
        onClick={onClear}
      >
        구간 초기화
      </button>
      {error ? (
        <span role="alert" className="text-amber-300">
          {error}
        </span>
      ) : (
        <span className="text-zinc-400">
          {external
            ? 'A-B 반복은 인앱 플레이어에서 지원합니다. 외부 플레이어에서는 자체 구간 반복 기능을 사용하세요.'
            : enabled
              ? 'A–B 반복 중 · 재생 중 범위 밖으로 이동하면 A로 돌아갑니다.'
              : '현재 위치를 A·B로 설정하세요. 영상이나 재생 소스를 바꾸면 초기화됩니다.'}
        </span>
      )}
    </div>
  )
}
