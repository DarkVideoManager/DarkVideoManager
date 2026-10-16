import { PLAYBACK_RATES } from '../../../shared/playbackRate'

export default function PlaybackRateControl({
  rate,
  onChange,
  disabled,
  pending,
  hint,
}: {
  rate: number
  onChange: (rate: number) => void
  disabled?: boolean
  pending?: boolean
  hint: string
}) {
  const options = PLAYBACK_RATES.includes(rate as (typeof PLAYBACK_RATES)[number])
    ? [...PLAYBACK_RATES]
    : [...PLAYBACK_RATES, rate].sort((a, b) => a - b)
  return (
    <div
      role="group"
      aria-label="재생 배속"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200"
    >
      <label className="flex items-center gap-2">
        배속
        <select
          aria-label="재생 배속 선택"
          value={disabled ? '' : rate}
          disabled={disabled || pending}
          onChange={(event) => onChange(Number(event.target.value))}
          className="rounded bg-zinc-800 px-2 py-1 disabled:opacity-50"
        >
          {disabled && <option value="">외부에서 확인</option>}
          {options.map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </label>
      <span aria-live="polite">{disabled ? '앱에서 현재 배속 확인 불가' : `현재 ${rate}×`}</span>
      <button
        type="button"
        disabled={disabled || pending || rate === 1}
        onClick={() => onChange(1)}
        className="rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700 disabled:opacity-40"
      >
        1배속으로 복귀
      </button>
      <span className="text-zinc-400">{pending ? '배속 적용 중...' : hint}</span>
    </div>
  )
}
