function measured(value, { zero = false } = {}) {
  return typeof value === 'number' && Number.isFinite(value) && (zero ? value >= 0 : value > 0)
}

export default function VideoTechnicalInfo({ video }) {
  const unknown = '정보 없음'
  const rows = [
    ['프레임레이트 (FPS)', measured(video.fps) ? `${Number(video.fps.toFixed(3))} FPS` : unknown],
    [
      '해상도',
      measured(video.width) && measured(video.height)
        ? `${video.width} × ${video.height}`
        : unknown,
    ],
    [
      '길이',
      measured(video.durationSec, { zero: true })
        ? `${Math.floor(video.durationSec / 60)}분 ${Math.floor(video.durationSec % 60)}초`
        : unknown,
    ],
    ['코덱', video.codec || unknown],
    ['컨테이너', video.container || unknown],
    ['비트레이트', measured(video.bitrate) ? `${Number(video.bitrate.toFixed(1))} kbps` : unknown],
    [
      '파일 크기',
      measured(video.sizeBytes, { zero: true })
        ? `${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB`
        : unknown,
    ],
    ['파일 이름', video.fileName],
    ['파일 위치', video.filePath],
  ]
  return (
    <section
      aria-label="영상 메타데이터"
      className="rounded border border-zinc-700 bg-zinc-950/40 p-3"
    >
      <h3 className="mb-2 text-xs font-semibold text-zinc-200">영상 정보</h3>
      <dl className="space-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="min-w-0 break-all text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      {!measured(video.fps) && (
        <p className="mt-2 text-xs text-zinc-500">
          파일을 분석할 때 프레임레이트를 확인하지 못했습니다. 임의의 값으로 표시하지 않습니다.
        </p>
      )}
    </section>
  )
}
