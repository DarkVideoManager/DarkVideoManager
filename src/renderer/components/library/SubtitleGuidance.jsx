const repository = 'https://github.com/DarkVideoManager/DarkVideoManager'
const linkClass = 'text-indigo-300 underline hover:text-indigo-200'

export function SubtitlePrivacyGuidance() {
  return (
    <details className="space-y-2 text-xs leading-relaxed text-zinc-400">
      <summary className="cursor-pointer text-zinc-200">개인정보 처리 · 공식 배포 확인</summary>
      <p>
        영상·음성 인식과 재생 기록은 PC에서 처리·저장합니다. 자막 번역을 선택해도 Google Cloud
        사용은 기본으로 꺼져 있습니다. 사용을 켜고 API 키를 저장한 경우에만 자막 텍스트·언어와 인증
        정보를 Google에 보냅니다. 영상·음성·파일 경로는 이 번역 요청에 포함하지 않습니다.
      </p>
      <p>
        Google 사용을 끄거나 키·한도가 없거나 요청이 실패하면 설치된 로컬 Ollama로 전환합니다. 로컬
        환경도 준비되지 않았으면 원어 자막을 보관하고 번역 실패를 표시합니다. 설치·모델 다운로드에는
        인터넷을 사용합니다.
      </p>
      <p>
        Stash 조회도 기본으로 꺼져 있으며 연결을 켜고 후보 조회를 누를 때 입력한 검색어와 인증
        정보를 지정 서버에 보냅니다. 추천 탐색은 PC에서 처리합니다. 긴급 탈출의 웹페이지 열기를
        선택하면 실행할 때 지정 사이트에 접속하며 브라우저 기록이 남을 수 있습니다.
      </p>
      <p>
        공식 GitHub Releases에서 실행파일과 같은 릴리스의 SHA256SUMS.txt·VERIFICATION.md를
        확인하세요. 해시 일치는 배포 파일과의 일치 확인이며, 소스 공개나 해시 일치만으로 보안 검증
        완료를 뜻하지 않습니다.
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <a
          className={linkClass}
          href={repository + '/blob/main/docs/PRIVACY.md'}
          target="_blank"
          rel="noreferrer"
        >
          개인정보 처리 전문
        </a>
        <a
          className={linkClass}
          href={repository + '/releases/latest'}
          target="_blank"
          rel="noreferrer"
        >
          공식 다운로드·검증 파일
        </a>
      </div>
    </details>
  )
}

export function SubtitleStartGuidance() {
  return (
    <details className="space-y-2 text-xs leading-relaxed text-zinc-400">
      <summary className="cursor-pointer text-zinc-200">처음 자막 만들기 · 모델·언어·비용</summary>
      <ol className="list-decimal space-y-1 pl-5">
        <li>라이브러리에서 영상을 선택하고 정보 탭의 AI 자막 생성으로 이동합니다.</li>
        <li>음성 인식 모델과 영상 언어를 선택합니다. large-v2도 모델 목록에서 고를 수 있습니다.</li>
        <li>
          한국어 번역이 필요하면 선택합니다. 상단 자막 생성 탭에서 로컬 환경과 Google 사용 여부를
          확인합니다.
        </li>
        <li>자막 생성 시작을 누르고, 자막 생성 큐에서 단계·완료·실패 상태를 확인합니다.</li>
        <li>
          영상 옆의 .ai.srt(원어), .ai.ko.srt(한국어)를 확인하고 플레이어의 자막 선택에서 고릅니다.
          기존 파일은 번호를 붙여 보존합니다.
        </li>
      </ol>
      <p>
        영상을 재생하는 것만으로 시작하지 않습니다. 실시간 통역이 아닌, 미리 자막 파일을 만드는
        작업입니다.
      </p>
      <p>
        언어는 자동 감지 또는 일본어·영어·한국어·중국어를 지정합니다. 자동 감지는 엔진의 지원 언어를
        찾으며 모든 언어의 품질을 보장하지 않습니다. 번역 대상은 한국어입니다.
      </p>
      <p>
        새 작업은 Windows whisper.cpp/Vulkan으로 인식하고, 한국어 번역은 WSL의 Ollama qwen3:8b 또는
        선택한 Google Cloud Translation이 처리합니다. 앱 이용료나 로컬 인식의 API 요금은 없습니다.
        Google은 별도 결제 계정·API 키가 필요하며 사용량에 따라 과금될 수 있습니다.
      </p>
      <p>
        먼저 기본 base로 짧은 영상을 확인하세요. 큰 모델은 다운로드·메모리·처리 부담이 늘며, 영상
        길이·음질·GPU·번역 경로에 따라 시간이 달라집니다. 다른 플레이어보다 정확하거나 일정 시간
        안에 완료된다는 비교 측정은 없습니다.
      </p>
      <a
        className={linkClass}
        href={repository + '/blob/main/docs/subtitles.md'}
        target="_blank"
        rel="noreferrer"
      >
        자막 설치·모델·비용 자세히 보기
      </a>
    </details>
  )
}

export function SubtitleSetupGuidance() {
  return (
    <details className="space-y-2 text-xs leading-relaxed text-zinc-400">
      <summary className="cursor-pointer text-zinc-200">
        설치 전 확인 · 권한 승인 · Ubuntu 초기 설정
      </summary>
      <p>
        Windows x64, Vulkan 지원 GPU와 최신 드라이버가 필요합니다. 새 작업은 GPU 초기화 실패 시
        CPU로 자동 전환하지 않습니다. 처음 설치에는 인터넷과 15GB 이상 여유 공간을 권장합니다.
      </p>
      <p>
        음성 인식 엔진·base 모델은 Windows에, 한국어 번역용 Python·Ollama·qwen3:8b는 WSL Ubuntu에
        준비합니다. 준비된 구성 요소는 재사용합니다.
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          자막 환경 자동 설치를 누릅니다. Windows WSL 구성 요소가 없으면 관리자 승인 창이 나타날 수
          있습니다. 직접 시작한 설치인지 확인하고 승인합니다. 조직 PC는 관리자에게 문의하세요.
        </li>
        <li>
          Windows 재시작 필요가 표시되면 작업을 저장하고 재부팅합니다. 앱을 다시 열어 설치 이어서
          진행을 누릅니다.
        </li>
        <li>
          보통 Ubuntu 계정은 앱이 자동 준비합니다. 최초 사용자 설정 메시지가 계속 표시되는 경우에만
          시작 메뉴에서 설치된 Ubuntu를 열고 Linux 사용자명과 암호를 만듭니다. 암호 입력 중 문자가
          보이지 않는 것은 정상입니다.
        </li>
        <li>
          앱으로 돌아와 환경 다시 확인 또는 설치 다시 시도를 누릅니다. Microsoft Store에서 다른
          Ubuntu를 추가 설치하기 전에 현재 설치 상태부터 확인하세요.
        </li>
      </ol>
      <pre
        className="overflow-x-auto rounded bg-zinc-950 p-2"
        aria-label="Ubuntu 최초 설정 화면 예시"
      >
        {
          '화면 예시 (버전에 따라 문구가 다를 수 있음)\nEnter new UNIX username: 사용할 이름\nNew password: (입력한 문자는 표시되지 않음)\nRetype new password: 같은 암호 다시 입력'
        }
      </pre>
      <p>
        준비 중·재시작 필요는 실패와 구분됩니다. 실패하면 표시된 단계와 오류를 확인하고 다시
        시도하세요. 설치가 진행 중인 동안 같은 설치를 여러 번 실행하지 마세요.
      </p>
      <a
        className={linkClass}
        href={repository + '/blob/main/docs/subtitles.md#앱에서-자동-설치'}
        target="_blank"
        rel="noreferrer"
      >
        설치 단계·오류 안내 전문
      </a>
    </details>
  )
}
