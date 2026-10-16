import * as React from 'react'

export default function SubtitleGpuGuidance() {
  return (
    <details className="rounded border border-zinc-700 bg-zinc-950/40 p-3 text-xs text-zinc-300">
      <summary className="cursor-pointer font-medium text-indigo-200">
        AMD·NVIDIA 지원 · 실제 처리 장치 확인
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed">
        <p>
          새 작업의 음성 인식은 Windows의 whisper.cpp와 Vulkan을 사용합니다. AMD Radeon과 NVIDIA
          GeForce 모두 Vulkan을 지원하는 GPU와 제조사의 호환 드라이버가 필요합니다. 음성 인식을 위해
          CUDA나 ROCm을 따로 설치할 필요는 없습니다.
        </p>
        <dl className="space-y-2">
          <div>
            <dt className="font-medium text-zinc-100">음성 인식 · Windows / Vulkan</dt>
            <dd>
              작업의 ‘음성 인식’ 항목을 확인하세요. ‘실제 처리 장치 확인 전’은 아직 GPU 사용을
              확인하지 않은 상태입니다. ‘Vulkan GPU · Vulkan0 (엔진 확인)’은 엔진이 사용을 확인한
              장치 식별자이며 그래픽카드 제품명과 다를 수 있습니다.
            </dd>
          </div>
          <div>
            <dt className="font-medium text-zinc-100">한국어 번역 · Ollama 또는 Google Cloud</dt>
            <dd>
              로컬 Ollama 번역은 WSL의 별도 환경입니다. GPU 사용 조건은 Ollama 버전, GPU와
              드라이버에 따라 다릅니다. 음성 인식의 Vulkan 표시가 번역 GPU 사용까지 뜻하지는
              않습니다. 번역 장치는 Ollama 로그에서 별도로 확인하세요. Google Cloud 번역은 외부
              서비스에서 처리합니다.
            </dd>
          </div>
        </dl>
        <p>
          새 음성 인식 작업은 GPU 초기화가 실패하면 오류를 표시하고 멈추며 CPU로 자동 전환하지
          않습니다. 예전에 CPU로 시작한 작업을 재개할 때만 기존 CPU 처리 경로를 유지합니다. 음성
          추출과 구간 감지는 CPU를 사용할 수 있어 CPU 사용량만으로 판단할 수 없습니다.
        </p>
        <p>
          Vulkan 오류가 나면 제조사 드라이버와 GPU 지원 여부를 확인하세요. 메모리 부족 오류에는 더
          작은 모델로 짧은 영상을 먼저 확인하세요. 모든 Radeon·GeForce 제품의 실물 검증이 완료된
          것은 아니며, 특정 제품의 성능이나 성공을 보장하지 않습니다.
        </p>
        <p className="rounded bg-amber-950/30 p-2 text-amber-100">
          HCS_E_HYPERV_NOT_INSTALLED 또는 가상 머신 시작 오류는 WSL 환경 준비 문제입니다. Windows
          가상 머신 플랫폼, BIOS/UEFI의 CPU 가상화와 하이퍼바이저 시작 설정을 확인하세요. 이
          오류만으로 AMD·NVIDIA 미지원이나 음성 인식 모델 문제로 판단하지 않습니다.
        </p>
      </div>
    </details>
  )
}
