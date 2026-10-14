export default function TranslationPreview() {
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400">
      <summary className="cursor-pointer text-zinc-300">
        체험 자막과 번역은 어떻게 만들어지나요?
      </summary>
      <p className="mt-3 leading-relaxed">
        야구 영상에 맞춰 사람이 작성한 다국어 장면 설명을 사용합니다. 음성 인식 모델 선택과 번역
        단계는 사용 흐름을 보여주는 시뮬레이션입니다. API 키 입력이나 다운로드 없이 체험할 수
        있으며, 저장한 자막과 기록은 이 브라우저에만 남습니다.
      </p>
    </details>
  )
}
