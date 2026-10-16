const modelGuides = {
  tiny: '자원 부담이 가장 작은 선택입니다. 설치·인식 동작 확인이나 메모리가 부족할 때 먼저 시험하세요.',
  base: '기본 시작 모델입니다. 같은 언어의 짧은 영상에서 인식 결과와 처리 부담을 먼저 확인하세요.',
  small:
    'base의 인식 결과가 아쉬울 때 비교할 다음 후보입니다. 메모리와 처리 부담이 늘어날 수 있습니다.',
  medium: 'small과 결과를 비교할 중대형 모델입니다. 여유 메모리와 긴 처리 시간을 고려하세요.',
  'large-v2':
    '자원 부담이 큰 비교용 후보입니다. 충분한 메모리를 확보하고 짧은 영상으로 먼저 확인하세요.',
  'large-v3':
    '자원 부담이 큰 비교용 후보입니다. 같은 영상에서 v2와 비교하세요. 항상 더 정확한 것은 아닙니다.',
}

export default function SubtitleModelGuide({ model, language }) {
  return (
    <div className="space-y-2 text-[11px] leading-relaxed text-zinc-400">
      <p aria-label="선택한 모델 안내" aria-live="polite">
        <strong className="font-medium text-zinc-300">{model}</strong>: {modelGuides[model]}
      </p>
      {language === 'auto' && (
        <p>
          영상의 주된 언어를 알면 영상 언어에서 직접 지정하세요. 자동 감지 오류를 줄이는 데 도움이
          될 수 있습니다.
        </p>
      )}
      <details className="space-y-2 rounded border border-zinc-700 px-3 py-2">
        <summary className="cursor-pointer text-zinc-200">내 PC·영상에 맞는 모델 선택</summary>
        <p>
          Whisper 모델은 음성을 원어 자막으로 바꿉니다. 한국어 번역은 별도의 Ollama qwen3:8b 또는
          사용자가 켠 Google Cloud Translation이 처리합니다. 인식 모델 변경으로 번역 모델이 바뀌지는
          않습니다.
        </p>
        <ul className="list-disc space-y-1 pl-4">
          <li>처음 사용: base로 같은 언어의 짧은 영상부터 확인합니다.</li>
          <li>
            GPU 메모리가 부족하거나 처리가 부담될 때: tiny 또는 base로 낮추고 다른 GPU 작업을
            정리합니다.
          </li>
          <li>
            여유 메모리가 있고 인식 오류가 많을 때: 언어·음질을 확인한 뒤 small → medium →
            large-v2/v3 순으로 같은 영상의 결과를 비교합니다.
          </li>
          <li>
            긴 영상·여러 편 처리: 짧은 영상에서 품질과 소요 시간을 확인한 모델로 시작합니다. 전체
            시간은 영상 길이·음질·장치·번역 경로에 따라 달라집니다.
          </li>
          <li>
            일본어·영어·한국어·중국어: 주된 언어를 직접 고릅니다. 언어를 모르거나 다른 언어이면 자동
            감지를 시도합니다. 언어별로 항상 가장 좋은 모델은 정해져 있지 않습니다.
          </li>
        </ul>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="mb-1 text-left text-zinc-300">
              현재 선택 가능한 음성 인식 모델
            </caption>
            <thead>
              <tr>
                <th className="pr-3">모델</th>
                <th>선택 기준</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(modelGuides).map(([name, guide]) => (
                <tr key={name}>
                  <th scope="row" className="py-1 pr-3 font-normal text-zinc-300">
                    {name}
                  </th>
                  <td>{guide}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          일반적으로 큰 모델은 저장 공간·메모리와 처리 부담이 커지며 인식 개선을 기대하고 비교할 수
          있습니다. 더 큰 모델이나 특정 언어의 정확도·처리 시간은 보장하지 않습니다. 다운로드 용량은
          실행 중 필요한 메모리와 다릅니다.
        </p>
        <p>
          새 작업은 Vulkan 지원 GPU가 필요하며 CPU로 자동 전환하지 않습니다. GPU 초기화 오류는 작은
          모델만으로 해결되지 않을 수 있습니다. 모델과 언어는 바로 위 선택 메뉴에서 바꾸고 다음
          작업을 시작하세요. 이미 큐에 추가한 작업의 설정은 바뀌지 않습니다.
        </p>
        <a
          className="text-indigo-300 underline hover:text-indigo-200"
          href="https://github.com/DarkVideoManager/DarkVideoManager/blob/main/docs/subtitles.md#모델언어사양비용"
          target="_blank"
          rel="noreferrer"
        >
          모델 용량·설치·번역 안내
        </a>
      </details>
    </div>
  )
}
