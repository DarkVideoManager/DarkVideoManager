// Only the website build applies these adaptations. The desktop renderer stays intact.
function replaceCopy(code: string, original: string, replacement: string): string {
  const pattern = new RegExp(
    original
      .trim()
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+'),
    'g',
  )
  if (!pattern.test(code))
    throw new Error(`Browser demo copy is out of date: ${original.slice(0, 70)}`)
  return code.replace(pattern, () => replacement)
}

export function browserCopy(code: string, id: string): string | undefined {
  const path = id.replaceAll('\\', '/').split('?')[0]
  let edits: Array<[string, string]> = []
  if (path.endsWith('/src/renderer/components/library/SubtitleGenerationPanel.jsx')) {
    edits = [
      ['AI 자막 생성', '자막 생성 시뮬레이션'],
      [
        '시작하면 작업 큐에 추가해 순서대로 처리합니다. 다른 영상도 이어서 추가할 수 있습니다.',
        '약 15초 동안 생성 과정을 체험하고, 준비된 장면 설명 자막을 저장합니다. 다른 영상도 큐에 추가할 수 있습니다.',
      ],
      ['음성 인식 모델', '모델 설정 체험'],
      ['자동 감지</option>', '자동 감지 체험 · 영어</option>'],
      [
        '대형 모델이 없으면 약 3.1GB를 다운로드하며 실행 시 더 많은 메모리가 필요합니다. 먼저 짧은 영상으로 확인하세요.',
        '대형 모델을 고르는 설정 체험입니다. 모델을 내려받지 않으며 예시 자막과 속도는 같습니다.',
      ],
      [
        '선택한 모델이 없으면 처음 생성할 때 다운로드합니다. 기본 base부터 짧은 영상으로 확인할 수 있습니다.',
        '모델을 고르는 설정 체험입니다. 다운로드 없이 준비된 예시 자막을 사용합니다.',
      ],
      [
        '음성 인식은 내 PC에서 처리합니다. Google Cloud 사용은 기본으로 꺼져 있으며, 자막 생성 탭에서 사용을 켜고 API 키를 저장한 경우 인식한 텍스트를 전송합니다. 사용을 끄거나 키·한도가 없거나 요청에 실패하면 PC의 Ollama를 사용합니다.',
        '이 브라우저에서는 AI 실행 대신 수작업 예시 자막으로 과정을 재현합니다. 모델 선택은 설정 체험이며, 결과와 속도는 같습니다. 프로그램 설치·API 키·외부 전송은 필요 없습니다.',
      ],
      [
        '‘자막 생성 시작’은 기존 자막을 보존합니다. 영상 옆에 .ai.srt와 .ai.ko.srt를 저장하며, 같은 이름이 있으면 번호를 붙입니다.',
        '‘자막 생성 시작’은 기존 자막을 보존하고 새 체험 자막을 이 브라우저에 저장합니다. 완료 후 자막 탐색에서 문장을 눌러 해당 장면으로 이동하세요.',
      ],
      [
        '자막 생성 탭에서 필요한 프로그램과 모델을 자동으로 설치할 수 있습니다.',
        '자막 생성 탭에서 체험할 영상을 고르고 작업을 다시 시작할 수 있습니다.',
      ],
      ['자막 환경 자동 설치 열기', '자막 생성 체험 열기'],
      ['기존 자막 삭제 후 재생성', '기존 자막 교체 체험'],
      [
        '재생성 작업을 큐에 추가합니다. 차례가 되면 다음 자막 파일을 휴지통으로 이동한 뒤 새 자막을 생성합니다.',
        '재생성 체험을 큐에 추가합니다. 성공적으로 완료되면 다음 자막을 새 예시 자막으로 교체합니다.',
      ],
      ['삭제할 자막 파일', '교체할 체험 자막'],
      [
        '원본 영상과 내장 자막은 유지합니다. 재생성이 실패하면 기존 자막은 휴지통에서 복원할 수 있습니다.',
        '완료 전까지 기존 자막을 유지합니다. 취소하거나 저장에 실패해도 기존 자막은 보존합니다.',
      ],
      ['삭제 후 재생성', '교체 체험 시작'],
    ]
  } else if (path.endsWith('/src/renderer/components/library/SubtitleGuidance.jsx')) {
    edits = [
      ['개인정보 처리 · 공식 배포 확인', 'Windows 앱 안내 · 개인정보와 공식 배포'],
      ['처음 자막 만들기 · 모델·언어·비용', 'Windows 앱 안내 · 자막·모델·비용'],
      ['설치 전 확인 · 권한 승인 · Ubuntu 초기 설정', 'Windows 앱 안내 · 설치와 Ubuntu 초기 설정'],
      [
        '</summary>',
        '</summary><p className="text-indigo-200">아래는 Windows 앱의 안내입니다. 브라우저 체험에서는 프로그램 설치·모델 다운로드·실제 AI 인식이나 번역·외부 전송을 실행하지 않습니다.</p>',
      ],
    ]
  } else if (path.endsWith('/src/renderer/components/library/SubtitleProcessingStatus.jsx')) {
    edits = [
      ['처리 장치 기록 없음', '브라우저 시뮬레이션'],
      ['실제 처리 장치 확인 전', '브라우저 시뮬레이션'],
      ['음성 인식: {asr}', '체험 처리: {asr}'],
      [
        '음성 추출·음성 구간 감지는 CPU를 사용할 수 있습니다. 번역은 음성 인식과 별도 단계입니다.',
        '실제 음성 인식이나 번역을 실행하지 않습니다. 준비된 장면 설명으로 생성 과정을 체험합니다.',
      ],
    ]
  } else if (path.endsWith('/src/renderer/pages/SubtitleQueuePage.jsx')) {
    edits = [
      [
        '라이브러리에서 영상 선택 → 정보 → AI 자막 생성으로 작업을 추가하세요. 대기 중인 작업은 순서대로 처리합니다.',
        '위에서 영상을 고르거나 영상 상세 정보에서 작업을 추가하세요. 대기 중인 체험 작업은 순서대로 진행됩니다.',
      ],
      [
        '대기·진행·일시정지 작업이 있으면 ESC 또는 창 닫기(X)로 닫아도 트레이에 남습니다. 트레이 아이콘을 두 번 클릭하면 다시 열립니다.',
        '생성 중에도 영상 재생·하이라이트·썸네일 저장을 체험할 수 있습니다. Esc로 체험 화면을 가리고 화면 다시 열기로 돌아옵니다.',
      ],
      [
        '트레이 메뉴의 완전히 종료를 사용하면 미완료 큐를 보관합니다. 다음 실행에서 재개를 누르면 이어갑니다. 작업을 삭제해도 이미 저장된 자막 파일은 보존합니다.',
        '새로고침하거나 브라우저를 다시 열면 진행하던 작업은 일시정지 상태로 복원됩니다. 재개를 눌러 이어가세요. 작업을 삭제해도 저장된 자막은 유지됩니다.',
      ],
      [
        '<div className="flex flex-wrap items-center gap-2">',
        `<div className="flex flex-wrap items-center gap-2">
          {job.phase === 'completed' && <Link to={\`/player/\${encodeURIComponent(job.libraryId)}/\${encodeURIComponent(job.videoId)}?panel=subtitles\`} className="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500">자막 탐색하기</Link>}`,
      ],
    ]
  } else if (path.endsWith('/src/renderer/components/player/VideoPlayer.jsx')) {
    code = `import { browserPlayerKey, ignoreBrowserPlayerKey, announceBrowserPlayerKey } from '@demo-keyboard'\n${code}`
    edits = [
      [
        'isTextEditingTarget(target) || subtitleNavigationTarget?.contains(target)',
        'isTextEditingTarget(target) || ignoreBrowserPlayerKey(event, subtitleNavigationTarget)',
      ],
      ['const key = event.key.toLowerCase()', 'const key = browserPlayerKey(event)'],
      [
        'if (useInAppPlayback && videoElement) {',
        'if (useInAppPlayback && videoElement) {\n        announceBrowserPlayerKey(event)',
      ],
      [
        "if (key === ' ' || key === 'spacebar' || key === 'p') {",
        "if (key === ' ' || key === 'spacebar' || key === 'p' || key === 'w') {",
      ],
      [
        'event.key.toLowerCase() === activeSeekKeyRef.current',
        'browserPlayerKey(event) === activeSeekKeyRef.current',
      ],
      [
        'pointer-events-none absolute inset-x-0 z-20 flex justify-center px-8',
        'demo-player-caption pointer-events-none absolute inset-x-0 z-20 flex justify-center px-8',
      ],
      [
        'max-h-40 shrink-0 overflow-y-auto border-t border-zinc-700 bg-zinc-900 px-3 py-2',
        'demo-player-highlights max-h-40 shrink-0 overflow-y-auto border-t border-zinc-700 bg-zinc-900 px-3 py-2',
      ],
    ]
  } else if (path.endsWith('/src/renderer/components/library/DetailPanel.jsx')) {
    edits = [
      ['Space/P: 일시정지', 'W / Space / P: 재생·일시정지'],
      ['A/D 또는 좌우: 이동', 'A/D: 1초 이동 · Shift: 5초 이동'],
    ]
  } else if (path.endsWith('/src/renderer/pages/PlayerPage.jsx')) {
    edits = [
      ['import { useNavigate, useParams }', 'import { useNavigate, useParams, useLocation }'],
      [
        'const navigate = useNavigate()',
        'const navigate = useNavigate()\n  const browserLocation = useLocation()',
      ],
      [
        "initialTab={'highlights'}",
        "initialTab={new URLSearchParams(browserLocation.search).get('panel') === 'subtitles' ? 'subtitles' : 'highlights'}",
      ],
    ]
  } else if (path.endsWith('/src/renderer/router.tsx')) {
    edits = [
      [
        'export default function AppRouter() {',
        `router.subscribe(() => window.dispatchEvent(new Event('dvm-demo-route-change')))
export default function AppRouter() {`,
      ],
    ]
  } else if (path.endsWith('/src/renderer/pages/StatsPage.jsx')) {
    edits = [['AI 생성 자막', '생성 체험 자막']]
  } else return undefined
  return edits.reduce((result, [from, to]) => replaceCopy(result, from, to), code)
}
