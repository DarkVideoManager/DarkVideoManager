# Windows 배포본 기능 복구

기준 배포본은 DarkVideoManager 0.1.0의 `resources/app.asar`입니다.
ASAR SHA-256: `b8917658981deebce3912c9e40aed64a84a393630d18efbcd94eb27ac3a9bbc7`.
원본 배포 폴더와 사용자 라이브러리는 수정하지 않았습니다.

## 실행 및 빌드

Windows x64와 Node.js/npm이 필요합니다. 의존성 버전은 `package-lock.json`으로 고정합니다.

```powershell
npm run setup
npm run typecheck
npm test
npm run build
npm run dev
```

`setup`은 일반 의존성을 `npm ci --ignore-scripts`로 설치한 다음 Electron 런타임과
FFmpeg를 준비하고, 배포본에서 회수한 SQLite 네이티브 모듈의 버전·SHA-256을 검사해 설치합니다.
해당 모듈은 `resources/native/win32-x64-electron-125/`에 원래 라이선스와 함께 보관했습니다.
Electron 또는 better-sqlite3 버전을 변경할 때는 해당 ABI에 맞는 네이티브 모듈도 다시 빌드해야 합니다.

기본적으로 형제 폴더 `../win-unpacked`에 검증된 FFmpeg가 있으면 이를 재사용합니다.
없으면 패키지의 공식 설치 스크립트로 다운로드합니다. 다른 위치의 배포본은
`npm run setup -- "D:\\path\\to\\win-unpacked"`로 지정할 수 있습니다.

```powershell
npm run build:unpacked
# 결과: dist-electron/win-unpacked/DarkVideoManager.exe

npm run build:win
# NSIS 설치 프로그램과 포터블 실행 파일
```

`electron-builder.yml`은 Windows x64용 미디어 바이너리만 포함하고 중복 복사를 제외합니다.
SQLite는 준비된 Electron ABI 125 모듈을 사용하므로 패키징 단계에서 다시 컴파일하지 않습니다.

이번 Windows 환경에서는 electron-builder 24의 `winCodeSign` 도구 압축에 포함된 macOS
심볼릭 링크가 권한 오류를 일으켰습니다. 다운로드된 공식 도구에서 Windows에 불필요한
`darwin` 항목만 제외해 로컬 도구 캐시를 준비한 뒤 정상 패키징했습니다.
다른 PC에서 같은 문제가 생기면 `npx electron-builder --win --dir -c.win.signAndEditExecutable=false`로
실행 파일 리소스 편집을 생략하여 패키징할 수 있습니다. 이 경우 EXE 아이콘·제품 버전 정보는 기본값이 남습니다.

## 복구된 기능과 위치

| 기능                                                         | 주요 소스                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 상단 헤더, 라이브러리 선택·생성·삭제, 폴더 가져오기·새로고침 | `src/renderer/pages/LibraryPage.jsx`, `electron/main/services/LibraryService.ts`              |
| 검색, 정렬, 가상화 목록, 검색·정렬·스크롤·볼륨 저장          | `src/renderer/api/useVideos.ts`, `components/library/VideoGrid.jsx`, `store/libraryStore.ts`  |
| CSV 평점·즐겨찾기 가져오기 및 미리보기                       | `components/library/CsvImportDialog.jsx`, `electron/main/services/DataImportService.js`       |
| 태그, 평점, 메모, 상세 패널, 휴지통·목록 제거와 복구         | `components/library/DetailPanel.jsx`, `VideoService.ts`, `db/repositories/VideoRepository.ts` |
| 썸네일 생성·재생성·대표 선택, 시간 지정 및 화면 캡처         | `ThumbnailCaptureService.js`, `electron/main/ffmpeg/thumbnail.ts`                             |
| 인앱 플레이어, 이어보기, 볼륨, 탐색·단축키                   | `components/player/VideoPlayer.jsx`, `PlaybackService.ts`                                     |
| AVI 재생용 MP4 생성, 로컬 미디어 스트리밍·Range              | `electron/main/ffmpeg/playback.js`, `electron/main/infra/localMedia.ts`                       |
| mpv·ffplay·VLC 선택·탐색·실행, mpv 이벤트·탐색 연동          | `NativePlayerService.ts`, `MpvSessionService.js`                                              |
| 자막 탐색, 인코딩 처리, SRT/SMI→VTT, 자막 위치 이동          | `SubtitleService.ts`, `VideoPlayer.jsx`                                                       |
| 하이라이트 생성·수정·삭제·탐색                               | `HighlightService.ts`, `DetailPanel.jsx`, `VideoPlayer.jsx`                                   |
| 기간별 통계와 많이 본 영상                                   | `pages/StatsPage.jsx`, `StatsService.ts`                                                      |
| IPC 호출·이벤트, 입력 검증·구독 해제                         | `src/shared/`, `electron/preload/`, `electron/main/ipc/`                                      |
| 기존 DB에 태그·재생시간 추가                                 | `electron/main/db/migrations/003_metadata.sql`                                                |
| 제거 상태 보존 및 검색 인덱스                                | `electron/main/db/migrations/004_safe_removal.sql`, `005_search_indexes.sql`                  |
| 설정·재생 캐시 관리                                          | `components/settings/SettingsDialog.tsx`, `infra/config.ts`, `services/CacheService.ts`       |

원래 TypeScript 타입과 주석이 없는 부분은 읽을 수 있는 JSX/JavaScript로 복구했습니다.
React, Query, Zustand, Recharts 등의 vendor 번들은 소스에 복사하지 않고 npm 의존성을 사용합니다.
복구 서비스의 외부 인터페이스에는 `.d.ts`를 제공하고, IPC·API·store·repository 경계는 타입 검사를 유지합니다.
이는 원래 작성 당시의 파일을 바이트 단위로 복원한 결과가 아니라, 배포본 동작을 소스로 재구성한 결과입니다.

## 배포본과 의도적으로 달라진 동작

- 폴더 접근 실패 시 새로고침이 기존 영상 기록을 삭제하지 않습니다. 추가로 가져온 폴더도 저장하고 함께 새로고침합니다.
- 영상 목록은 5,000개로 잘리지 않고 페이지를 추가 조회합니다.
- 실제 재생 요소를 유지하고 메타데이터 로딩 후 이어보기 위치를 복원합니다.
- 시청 시간은 종료 재생 위치가 아닌 재생 진행량과 경과 시간을 기준으로 누적합니다.
- 원본 소스의 입력 검증, DB 쓰기 잠금·읽기 전용 처리, 마이그레이션 트랜잭션·백업 보호를 유지합니다.
- 썸네일 재생성 실패가 기존 썸네일을 지우지 않도록 합니다.

영상 제거는 기본적으로 Windows 휴지통으로 이동하며 UI에서 확인을 받습니다.
별도의 ‘목록에서만 제거’는 원본을 그대로 둡니다. 제거 상태에서도 평점·메모·재생 기록과
캡처를 보존하며, ‘제거한 항목’에서 목록으로 복구할 수 있습니다. 휴지통으로 옮긴 파일은
Windows 휴지통에서 원래 위치로 먼저 복원해야 합니다. 제거한 영상은 새로고침으로 다시 나타나지 않습니다.

mpv·ffplay·VLC는 별도 설치된 플레이어를 사용합니다. 모든 코덱의 인앱 재생을 보장하는 구현은 아닙니다.

## 복구 후 추가 개선

1. **설정 보호**: 같은 폴더의 임시 파일에 기록·동기화한 뒤 교체하고 이전 정상 설정을
   `.bak`으로 보관합니다. 손상된 설정은 별도 이름으로 보존하고 정상 백업에서 복원하며 알림을 표시합니다.
   설정과 백업이 모두 손상되면 빈 라이브러리로 덮어쓰지 않고 시작을 중단합니다. 중복 실행도 차단합니다.
2. **안전한 제거**: 휴지통 이동 성공 후에만 제거 상태를 기록하고, 목록만 제거하는 선택지를 제공합니다.
   원본이 돌아오면 기존 메타데이터와 함께 복구할 수 있습니다.
3. **대용량 작업**: 폴더 스캔·파일 검사·CSV 준비 작업에서 이벤트 루프에 제어를 돌려주고
   진행률과 취소를 제공합니다. 폴더 가져오기 취소 시 이미 추가된 영상은 남으며, 새로고침 취소·접근 실패는
   기존 기록을 정리하지 않습니다. 메타데이터 가져오기는 준비 완료 후 트랜잭션으로 적용하며 취소·실패 시
   적용 내용을 되돌립니다. 같은 라이브러리의 충돌하는 쓰기는 막고, 종료 시 작업 정리를 기다립니다.
   검색은 페이지 ID를 먼저 고른 뒤 썸네일 등을 조인하고 정렬별 부분 인덱스를 사용합니다.
4. **재생 캐시**: 설정에서 사용량과 재생 중 보호 용량을 확인하고 상한(기본 10 GB)을 저장하거나
   미사용 캐시를 정리할 수 있습니다. 자동 정리는 오래 사용하지 않은 AVI 재생용 프록시부터 제거합니다.
   재생·변환 중인 파일은 보호하며 이때 일시적으로 상한을 넘을 수 있습니다. 원본·DB·가져온 썸네일·캡처는
   정리 대상이 아닙니다. 앱 전용 `playback-proxies` 밖으로 이어지는 링크 경로는 거부합니다.
5. **외부 플레이어**: 설정에서 자동 탐색, 발견된 플레이어, 직접 고른 실행 파일을 선택합니다.
   자동 순서는 mpv → ffplay → VLC이며 각 종류의 기본 위치와 PATH를 확인합니다. 저장된 수동 경로가
   사라지면 설정 변경을 안내합니다. 프로세스 시작과 초기 실패를 확인한 뒤 성공을 알리고,
   실행 실패 시 인앱 재생과 재생 기록을 유지합니다.

상세 검색 성능은 `npm run benchmark:search`로 재측정할 수 있습니다. 이 PC의 메모리 SQLite에
가상 영상 10만 건을 넣은 비교에서 기본 첫 페이지 p95는 약 45→6 ms, 이름순 마지막 페이지는
220→8 ms였습니다. 14개 시나리오에서 기존 쿼리와 결과 ID·개수가 일치했습니다.
부분 문자열 `LIKE` 검색은 여전히 선형 비용이 있으며 실제 디스크·NAS 성능을 뜻하는 수치는 아닙니다.

## 검증 명령

```powershell
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run test:e2e
npm run build
npm run test:electron
npm run build:unpacked
npm run test:electron -- dist-electron/win-unpacked/DarkVideoManager.exe
npm run test:native
npm run benchmark:search
```

`npm test`는 Electron의 Node 런타임으로 실행하여 SQLite ABI를 일치시킵니다.
실제 Electron 검증은 임시 영상·CSV와 별도 `DVM_USER_DATA_DIR`을 만들며 사용자 자료를 열지 않습니다.
성공 결과와 화면은 `test-results/restoration-electron.json`, `restoration-packaged.json`, `restoration-electron.png`에 저장됩니다.
웹 E2E는 별도의 mock API로 화면·가져오기·목록 추가 로딩·이어보기 회귀를 검증합니다.
Windows에서는 설치된 Chrome을 우선 사용합니다. 다른 브라우저 실행 파일은 `CHROMIUM_PATH`로 지정합니다.
`test:native`는 설치된 VLC를 화면 없이 실행하고 별도 임시 설정·생성 영상으로 디코딩과 정상 종료를
확인합니다. 다른 설치 경로는 `npm run test:native -- "D:\\VLC\\vlc.exe"`로 지정합니다.
GUI 출력이나 mpv·ffplay 실물 테스트를 대신하지는 않습니다.

## 최초 복구의 검증 결과 (2026-10-01)

- `npm run setup` 재설치와 Electron ABI의 SQLite 로딩 성공 (SQLite 3.53.0).
- main/web TypeScript 검사 및 TS ESLint 통과. 복원 JS/JSX의 미정의 이름 검사도 통과.
- 단위·서비스·계약 테스트 39개 통과 (9개 파일).
- 화면 E2E 3개 통과: 주요 기능 흐름, 5,001개 목록, 지연 소스의 이어보기·최종 위치 저장.
- 실제 FFmpeg 영상 분석·썸네일 생성·AVI→H.264 프록시 테스트 통과.
- 개발 빌드 및 패키징한 EXE의 격리 테스트 통과: 폴더/CSV 가져오기,
  메타데이터·하이라이트·캡처·자막·Range 스트리밍·통계·삭제.
- 패키징한 EXE에서 실제 H.264 `<video>` 재생 진행과 renderer 오류 0건 확인.
- Windows 실행 폴더 생성 성공: 133개 파일, 483,190,351 bytes (약 461 MiB).

외부 mpv·ffplay·VLC의 실제 GUI 실행은 이 검증에 포함하지 않았습니다.
플레이어 탐색과 인자 구성, mpv 이벤트·오류·종료 처리는 자동 테스트로 검증했습니다.
기준 `app.asar`의 SHA-256은 작업 전후 동일합니다.

## 추가 개선 1~5단계의 검증 결과 (2026-10-01)

- 단위·서비스·계약 테스트 **115개 / 20개 파일 통과**. 설정 손상·저장 실패, 제거·복구,
  대용량 가져오기 취소·롤백, 캐시 경로·소유권, 외부 플레이어 실행 실패, 종료 중 변환 취소를 포함합니다.
- 화면 E2E **22개 통과**, 실패·건너뛰기·재시도 성공 항목 0개. 900×600 설정 창,
  캐시 변환 중 이탈·재진입, 오류 표시와 처리되지 않은 Promise 거절 방지도 확인했습니다.
- main/web TypeScript, TS/TSX ESLint와 복원 JS/JSX의 미정의 이름 검사 통과.
- 개발 빌드와 최종 패키징 EXE 모두 **9개 통합 검증 묶음 통과**, renderer 오류 0건.
  실제 H.264 재생, FFmpeg AVI 변환, SQLite 마이그레이션, 가져오기·캡처·통계,
  캐시 보호·정리, Windows 휴지통 이동과 실행할 수 없는 외부 플레이어의 오류 반환을 확인했습니다.
- 설치된 VLC에 `--` 경로 구분 인자를 전달하고 임시 영상의 디코딩·정상 종료를 확인했습니다.
  mpv·ffplay 실물 및 외부 플레이어 GUI 출력은 검증하지 않았습니다.
- 당시 실행 폴더: `dist-electron/win-unpacked/`, 135개 파일, 483,288,959 bytes (약 461 MiB).
  실행 파일의 제품 이름은 DarkVideoManager, 제품 버전은 0.1.0.0입니다. 실행 폴더의 동반 파일도 필요합니다.
- 결과: `test-results/unit-results.json`, `e2e-results.json`, `restoration-electron.json`,
  `restoration-packaged.json`, `native-vlc.json`, `search-benchmark.json`.

복원 기준인 원본 `../win-unpacked/resources/app.asar`의 SHA-256은 변경되지 않았습니다.

## 연속 탐색 개선 (2026-10-01)

- A/D·좌우 방향키를 길게 누를 때 최대 이동량은 5초입니다. 목표 위치는 기존 60ms 간격으로
  누적하되, 디코더가 이전 탐색을 완료할 때까지 중간 요청은 최신 목표 하나로 합칩니다.
  빠르게 처리되는 영상에서도 연속 미리보기 요청은 최소 100ms 간격으로 제한합니다.
- 키 해제·창 포커스 이동·슬라이더 드래그 종료 시 마지막 목표를 정확하게 적용합니다.
  탐색 중 오래된 영상 위치가 진행 막대를 뒤로 되돌리지 않고, 화면 이탈·소스 변경 후 남은 요청은 취소합니다.
  D→A처럼 방향을 바꾼 뒤 이전 키를 놓거나 이전 키의 자동 반복이 들어와도 현재 방향을 유지합니다.
- mpv는 연속 이동 중 `absolute+keyframes`, 키를 놓을 때 `absolute+exact`를 사용합니다.
  실제 시간으로 가속을 계산하고, 앱에서 하이라이트 위치를 지정하면 이전 키 반복 작업을 취소합니다.
  [mpv 탐색 명령](https://mpv.io/manual/master/#list-of-input-commands)의 정확도·성능 구분을 따릅니다.
- 탐색 시작 직전까지 실제 재생한 시간만 반영하고, 탐색 완료·이탈 위치는 별도의 `playback.seek`로
  저장하여 일시정지 상태의 작은 이동도 시청시간에 더하지 않습니다.

실제 Electron에서 생성한 H.264 영상(90초, 640×360, 24fps, GOP 240)을 같은 PC에서 비교했습니다.
재생/일시정지 A/D 시나리오의 탐색 중 위치 재지정은 각각 7~9회에서 0회로 줄었습니다.
개발 빌드의 재생 중 최대 화면 갱신 간격은 D 약 250→133ms, A 약 250→150ms였습니다.
일시정지 A 시나리오의 마지막 정확 탐색 대기는 약 77→279ms로 증가했습니다.
단일 실행 결과이며 키 입력 전달·가속 시작 지연을 포함합니다. 원본 인코딩과 저장 장치에 따른
디코딩 비용까지 없어지는 것은 아니며 모든 영상의 성능을 보장하는 수치는 아닙니다.

비교 데이터는 `test-results/seeking-baseline.json`, `seeking-updated.json`, `seeking-comparison.json`에 있습니다.
재검증은 `node scripts/smoke-seeking.cjs --label updated --fixture-report test-results/seeking-baseline.json`으로
동일 임시 영상을 재사용합니다. 사용자 원본 영상이나 사용자 라이브러리를 수정하지 않습니다.

최종 패키지에서도 동일 영상으로 6개 시나리오가 모두 통과했습니다(`seeking-packaged.json`).
탐색 중 재지정 0회, 재생 중 최대 화면 갱신 간격 D 약 150ms·A 약 117ms였으며,
최종 위치 정확도·키 해제 후 정상 재생·방향 반전 검증과 renderer 오류 0건을 확인했습니다.
전체 단위·서비스·계약 테스트 134개(22개 파일), 화면 E2E 30개, 타입·린트 검사,
패키징 EXE의 기존 9개 통합 검증도 통과했습니다. 병렬 검증 중 기존 캐시 스캔 테스트가
한 차례 5초 제한을 초과했으며 브라우저 테스트 종료 후 전체 134개를 변경 없이 다시 실행해 통과했습니다.
mpv의 12개 테스트에는 생성된 Lua를 Fengari VM에서 실행하는 회귀 검증이 포함되지만,
설치된 Windows mpv의 실제 영상 출력 검증은 포함되지 않습니다.

## GPU 확인과 외부 플레이어 가속 (2026-10-01)

- RX 9060 XT, 드라이버 32.0.31041.1004에서 패키징한 앱의 실제 H.264 재생을 확인했습니다.
  기본 실행의 CDP Media 속성은 `D3D11VideoDecoder`, 플랫폼 디코더 `true`였습니다.
  비교용 실행에서만 `--disable-accelerated-video-decode`를 사용하자 `FFmpegVideoDecoder`,
  플랫폼 디코더 `false`로 바뀌었습니다. 앱은 이미 GPU 디코딩을 사용하고 있었습니다.
- 같은 640×360 긴 GOP 영상의 12개 위치 이동 중앙값은 GPU 약 125.1ms, 소프트웨어 약 69.3ms였습니다.
  양쪽 모두 일반 재생 중 프레임 드롭 0개였습니다. 이 작은 영상에서는 GPU 탐색이 더 빠르지 않았고,
  첫 이동의 초기화 지연도 있었습니다. 이 결과로 고해상도·다른 코덱의 우열을 판단할 수는 없습니다.
  측정 조건과 원시 이벤트는 `test-results/gpu-baseline.json`에 있습니다.
- 인앱 GPU 디코딩 설정은 유지합니다. 디코더 완료 시간 평균에 따라 미리보기 간격을 60~100ms로
  조절하는 변경도 시험했으나 결과가 혼재하여 **최종판에는 적용하지 않았습니다**.
  기존 100ms 간격·한 번에 한 탐색·최신 목표 유지·키 해제 시 정확 이동을 유지합니다.
- 설정의 ‘인앱 재생 가속’은 Chromium의 디코딩·화면 합성 **지원 상태**를 표시합니다.
  현재 영상의 실제 디코더 사용을 확정하는 표시가 아닙니다.
  [Electron GPU 상태 API](https://www.electronjs.org/docs/latest/api/app#appgetgpufeaturestatus)를 사용합니다.
- 일반·추적 세션 양쪽 mpv 실행에 `--hwdec=auto-safe`를 추가했습니다. 사용 가능한 하드웨어 디코더를
  자동 선택하며 기본 소프트웨어 대체 동작을 유지합니다.
  [mpv 하드웨어 디코딩 옵션](https://mpv.io/manual/stable/#options-hwdec)을 따릅니다.
  mpv가 설치되어 있지 않아 실제 mpv GPU 출력은 검증하지 않았습니다.

GPU 확인 재실행: `node scripts/smoke-gpu.cjs --executable dist-electron/win-unpacked/DarkVideoManager.exe --fixture-report test-results/seeking-baseline.json --label packaged`.
격리된 테스트 데이터와 생성 영상을 사용하며, 이 명령은 비교를 위해 앱을 기본 모드와 소프트웨어 디코딩 모드로 각각 실행합니다.

추가 탐색 측정은 기존 100ms 패키지와 간격을 조정한 실험 빌드를 다른 테스트가 끝난 뒤 순서대로 실행했습니다.
두 버전 모두 6개 시나리오를 통과했고 탐색 중 위치 재지정은 0회였습니다.
재생 중 최대 화면 갱신 간격은 D 약 166.8→166.7ms로 사실상 같았고, A 약 166.3→133.2ms였습니다.
단일 비교이며 별도 실행에서는 수치가 달라졌으므로 전반적인 성능 향상으로 일반화하지 않습니다.
재생 D에서 표시 프레임은 29→21개로 줄고, 정지 D의 키 해제 후 최종 완료는 약 93.6→202.3ms로
늦어지는 결과도 있어 간격 조정은 제외했습니다. 원본 보고서는 `seeking-gpu-before-idle.json`,
`seeking-gpu-adaptive-idle.json`, `seeking-gpu-comparison.json`입니다.

최종 검증: 단위·서비스·계약 테스트 138개(23개 파일), 타입 검사와 린트, 최종 EXE의 기존 9개
통합 검증을 통과했습니다. 화면 E2E는 33개 중 32개가 최종 전체 실행에서 통과했으며,
초기 라이브러리 화면을 기다리다 5초 제한을 초과한 1개는 코드 변경 없이 단독 재실행해 통과했습니다
(`e2e-results.json`, `e2e-gpu-recheck.log`). 테스트 스크립트의 GPU 기록 변수를 선언 전에 참조한 오류도
수정 후 통합 검증을 다시 실행해 통과했습니다(`restoration-packaged.json`).
최종 `gpu-packaged.json`은 실제 디코더, 설정 API의 지원 상태와 Electron 상태의 일치,
기본·소프트웨어 비교 실행에서 재생/탐색·오류 없음까지 확인합니다. 실제 mpv 출력은 이 검증에 포함되지 않습니다.
