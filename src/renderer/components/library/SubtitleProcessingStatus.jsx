import * as React from 'react'

export default function SubtitleProcessingStatus({ job }) {
  const processing = job.processing
  const asr =
    processing?.asr === 'vulkan'
      ? `Vulkan GPU · ${processing.device || '장치 정보 없음'} (${processing.evidence === 'checkpoint' ? '이전 인식 기록' : '엔진 확인'})`
      : processing?.asr === 'cpu-legacy'
        ? `기존 CPU 작업 ${processing.evidence === 'checkpoint' ? '기록' : '재개'} · 저장한 진행 내용 유지`
        : ['completed', 'failed', 'cancelled'].includes(job.phase)
          ? '처리 장치 기록 없음'
          : '실제 처리 장치 확인 전'
  const translation = {
    cloud: 'Google Cloud',
    ollama: '로컬 Ollama · 처리 장치는 Ollama에서 관리',
    'original-ko': '한국어 원문 사용',
  }[processing?.translation]
  return (
    <div
      aria-label="자막 처리 장치"
      className="space-y-1 text-[11px] leading-relaxed text-zinc-400"
    >
      <p>음성 인식: {asr}</p>
      {translation && <p>한국어 번역: {translation}</p>}
      <p>
        음성 추출·음성 구간 감지는 CPU를 사용할 수 있습니다. 번역은 음성 인식과 별도 단계입니다.
      </p>
    </div>
  )
}
