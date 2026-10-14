# 공개 릴리스 절차

소스 공개 준비와 실행 파일 배포는 구분해서 확인합니다. 이 저장소의 MIT 라이선스는 자체 코드와 아이콘에 적용되며, 포함된 FFmpeg·x264와 다른 의존성의 조건을 대체하지 않습니다.

## 1. 소스 점검

```powershell
npm run setup
npm run audit:publication
npm audit --omit=dev --audit-level=high
npm run typecheck
npm run lint
npm test
npm run test:tooling
npm run test:e2e -- --workers=1
```

2026-10-14 의존성 검토: `npm audit --omit=dev`는 0건, 전체 검사는 moderate 9건(high·critical 0건)이었습니다. 남은 항목은 패치가 아직 없는 [`sprintf-js`의 과도한 정밀도 지정에 따른 작업 중단 문제](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 하나가 개발 의존성 경로에 중복 집계된 것입니다. 앱의 생산 의존성에는 포함되지 않습니다. 현재 `electron-builder`의 프록시 로깅은 고정된 형식 문자열을 사용하며, 테스트용 Fengari는 정밀도 길이를 제한합니다. 이 호출 경로에서는 외부 입력이 취약한 형식 문자열로 전달되는 경로를 확인하지 못했습니다. 향후 의존성·호출 방식 변경 시 다시 검토해야 하며, 이 검토가 전체 보안 감사를 대신하지는 않습니다.

검사기는 실제 비밀값을 출력하지 않습니다. 현재 파일과 접근 가능한 Git 이력을 검사하지만 탐지 결과만으로 모든 비밀의 부재를 보장하지는 않습니다. 의심 항목은 공개 전에 확인하고, 실제 비밀이 과거에 기록됐다면 해당 비밀을 폐기·교체합니다. 커밋 작성자 이메일과 개인 경로가 남은 과거 이력도 검토하세요. 기존 이력 수정은 별도 결정 사항입니다.

`npm run export:source`는 현재 소스만 `release/DarkVideoManager-버전-source.tar.gz`와 SHA-256 파일로 내보냅니다. Git 이력, 설치된 의존성, 생성된 실행 파일, 개인 영상·라이브러리·설정은 포함하지 않습니다. 새 파일도 포함하므로 아직 커밋되지 않은 변경은 먼저 검토하세요.

## 2. 실행 파일 준비

배포용 AI 자막 런타임은 모델 없이 빌드합니다. 개인 모델 캐시나 영상으로 배포 파일을 만들지 않습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-subtitles-gpu.ps1 -SkipModelDownload
node scripts/finalize-media.cjs --verify
npm run build:win
npm run export:source
```

`build:win`은 앱을 빌드하고 외부 라이선스·미디어 대응 소스 검사를 통과한 뒤 Windows 설치형과 포터블 EXE를 만듭니다. 출력은 `dist-electron/`입니다. 개발용 `build:unpacked`는 실행 폴더를 만들지만 공개 배포 검사 전체를 대신하지 않습니다.

`resources/subtitles/native`가 없는 기본 개발 빌드에는 AI 음성 인식 실행 파일이 포함되지 않습니다. AI 기능을 제공하는 정식 배포에서는 위 GPU 런타임 준비 단계를 생략하지 마세요. 번역에 필요한 WSL 환경과 사용자 선택 모델은 별도 설치 항목입니다.

## 3. 패키지 검증

```powershell
node scripts/smoke-electron.cjs dist-electron/win-unpacked/DarkVideoManager.exe
node scripts/smoke-subtitle-navigation.cjs dist-electron/win-unpacked/DarkVideoManager.exe
```

이 검사는 임시 미디어와 별도 앱 데이터 폴더를 사용합니다. 추가로 별도 Windows 계정 또는 깨끗한 가상 머신에서 설치·첫 실행·가져오기·재생·하이라이트·썸네일·자막 탐색을 확인하세요. GPU 자막은 지원 드라이버가 있는 실제 장치에서 확인해야 합니다. 로컬 테스트나 GitHub CI 통과를 모든 장치의 호환성 확인으로 기록하지 마세요.

### WSL 미설치 Windows에서 자막 환경 설치 재현

`test-fresh-windows-vm.ps1`과 `test-fresh-windows-run.ps1`은 별도 Hyper-V Windows 11 VM에서 실제 배포 앱의 설치 기능을 검사합니다. 호스트에는 Hyper-V와 `Default Switch`가 이미 준비되어 있어야 하며, 관리자 Windows PowerShell에서 실행합니다. 기본 VM 사양은 CPU 4개·메모리 4GB·동적 디스크 80GB이며 저장소에 최소 40GB의 여유 공간이 필요합니다. 중첩 가상화를 사용하므로 [Microsoft의 CPU·호스트 요구 사항](https://learn.microsoft.com/windows-server/virtualization/hyper-v/enable-nested-virtualization)도 충족해야 합니다.

준비할 `test-results/fresh-windows/payload/`에는 다음 파일을 넣습니다. `app/`에는 검사하려는 `win-unpacked/`의 **전체 내용**을 복사합니다.

```text
payload/
  app/DarkVideoManager.exe
  app/resources/…
  app/…                          # 나머지 배포 파일
  node_modules/playwright/…
  node_modules/playwright-core/…
  test-fresh-windows-guest.cjs     # scripts/의 같은 파일
```

저장소와 VM 이름은 실행마다 새 값을 사용합니다. 아래 ISO는 예시 경로이며, 준비 도구는 코드에 고정된 Microsoft 공식 SHA-256과 일치하는 25H2 한국어 또는 26H2 평가판 이미지만 허용합니다. 기존 VM이나 해당 VM 저장 폴더가 있으면 초기화를 거부합니다.

```powershell
$testStore = 'F:\DarkVideoManager-TestVM-20261014'
$testVM = 'DVM-Fresh-WSL-20261014'
powershell -NoProfile -File scripts/test-fresh-windows-vm.ps1 -Action Initialize -ISOPath 'E:\downloads\Win11_25H2_Korean_x64.iso' -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Info -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Baseline -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Install -ExecutionMode Interactive -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action TaskStatus -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Collect -StorePath $testStore -VMName $testVM
```

Windows의 최초 설정이 끝난 뒤 `Baseline`을 실행합니다. 이 단계는 앱을 실행하기 **전에** WSL 관련 Windows 기능이 꺼져 있고 등록된 배포판이 없음을 기록합니다. 같은 테스트 계정이 게스트 바탕 화면에 로그인한 상태에서 `Install -ExecutionMode Interactive`를 실행하세요. 설치 앱은 이 계정의 관리자 권한 예약 작업에서 실행되므로 PowerShell Direct 연결과 독립적으로 계속 실행되며, 게스트 앱 화면을 캡처할 수 있습니다. 예약 작업에 암호를 전달하거나 저장하지 않습니다.

`interactive-task-started`는 실행 요청이 접수되었다는 뜻입니다. `TaskStatus`로 진행 상황을 확인하고, 해당 실행의 launcher가 `state: finished`와 `finishedAt`·`exitCode`를 기록할 때까지 기다립니다. `Collect`로 가져온 같은 실행의 앱 보고서도 `completed: true`여야 최종 결과로 판단합니다. 앱 보고서는 화면 캡처와 종료 전에 `status`·`outcome`·`exitCode`를 먼저 보존하지만, 그 시점의 `completed: false`는 중간 기록입니다. 마지막 캡처와 종료가 끝나면 `finishedAt`을 기록하며 종료 문제는 `closeError`에 남습니다.

launcher와 앱 보고서가 모두 종료 코드 `10`, 앱 `outcome: restart-required`를 기록하고 활성 테스트 작업·앱·WSL 설치 프로세스가 없을 때만 `Reboot`로 **테스트 VM만** 재시작합니다. `Info`로 연결과 같은 계정의 로그인을 확인한 뒤 `Install -ExecutionMode Interactive`를 다시 실행하세요. 실패나 시간 초과 뒤 설치 프로세스가 남아 있다면 먼저 상태와 로그를 수집하고 기다립니다. 앱 종료만 보고 설치 프로세스를 강제 종료하거나 재시작하지 마세요. 도구는 재시작이나 설치 재시도를 자동 반복하지 않습니다.

설치가 끝나면 아래처럼 별도 검증을 실행하고, 다시 `TaskStatus`로 완료를 확인한 뒤 결과를 수집합니다.

```powershell
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Verify -ExecutionMode Interactive -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action TaskStatus -StorePath $testStore -VMName $testVM
powershell -NoProfile -File scripts/test-fresh-windows-run.ps1 -Action Collect -StorePath $testStore -VMName $testVM
```

호스트 단계별 보고서는 `test-results/fresh-windows/`, 수집한 게스트 증거는 그 아래 `guest-results/`에 남습니다. 최초 상태, 재시작 전후 설치 결과, 최종 확인 결과를 함께 보존하세요. 설치 완료 판정은 launcher 종료 코드 `0`, 앱 보고서의 `completed: true`·`outcome: ready`·`exitCode: 0`, 여섯 구성요소의 `ready`를 함께 확인한 경우에만 기록합니다. 이 절차 자체는 성공 기록이 아니며, VM에서 환경 설치가 완료되어도 GPU 음성 인식·실제 번역·성능이나 모든 새 PC의 호환성을 검증한 것은 아닙니다.

실행 중 `Collect`는 잠긴 로그 파일을 건너뛰고 `skippedLockedFiles`에 기록할 수 있습니다. 이때 또는 테스트가 진행 중일 때는 `collectionComplete: false`인 중간 자료이므로 최종 증거로 사용하지 않습니다. 작업 종료 뒤 다시 수집하여 `collectionComplete: true`와 최종 보고서·스크린샷을 확인하세요. 활성 테스트가 없는데 파일이 잠겼거나 다른 파일 오류가 발생하면 수집을 실패로 처리합니다.

도구는 VM ID·이름·디스크 경로와 게스트 컴퓨터명·마커를 확인하며, 설치 중 재시작·파일 교체를 거부합니다. `TaskStatus`는 테스트 계정의 WSL 설치 프로세스와 확인된 Windows 설치 자식 프로세스도 기록합니다. 부모 앱이 종료되어도 같은 PID·생성 시각·실행 경로의 설치 프로세스가 남아 있으면 새 설치·재시작·파일 교체를 거부합니다. 호스트의 WSL 설치·기능 변경·재시작을 수행하지 않습니다. 게스트용 임시 자격 증명과 VM 디스크는 별도 저장소에 보관하고 공개하지 마세요. `Collect`는 게스트의 테스트 결과 폴더만 수집합니다. 테스트 코드를 호스트에서 직접 실행하거나 호스트에 `DVM_FRESH_VM_TEST=1`을 설정하지 마세요.

실행 파일을 교체할 때는 게스트 테스트가 종료된 후 payload를 갱신하고 `UpdatePayload`를 실행합니다. 이 명령은 실행 파일·`app.asar`·테스트 코드와 명시된 자막 Python 코드·모델 목록·공개 CA 파일·라이선스 자료만 교체합니다. 최초 상태 기록과 앱 데이터는 보존합니다. 이 목록에 없는 네이티브 실행 파일이나 라이브러리가 바뀌었다면 전체 새 패키지로 새 VM을 준비해야 합니다. 초기화 실패 시 저장소는 자동 삭제되지 않으므로, 원인을 확인한 뒤 새 VM 이름으로 다시 시작합니다.

예외적으로 Windows 이미지 적용 뒤 VM 등록 전에 준비가 중단되었다면 준비 도구의 `Resume`을 사용할 수 있습니다. 이 작업은 같은 저장소의 소유 기록·검증된 ISO 해시·분리된 가상 디스크·파티션·Windows 파일과 서명을 확인하고, 이미 게스트 설정이 시작된 디스크는 거부합니다. 디스크를 초기화하거나 이미지를 다시 적용하지 않습니다. 호스트의 오프라인 DISM 검사 결과를 최초 상태 증거로 대신하지 않으며, 재개한 경우에도 게스트 `Baseline` 통과가 필수입니다.

서명 인증서는 저장소에 넣지 않습니다. 서명하지 않은 EXE는 Windows의 출처 확인 경고가 표시될 수 있습니다. 코드 서명과 인증서 발급은 별도 배포 선택입니다.

## 4. 함께 공개할 파일

- 설치형 EXE 또는 포터블 EXE와 버전별 SHA-256
- 같은 버전의 DarkVideoManager 소스 압축 파일 및 SHA-256
- `release/sources/dvm-media-corresponding-source.tar.gz`
- `release/sources/BUILD.md`, `release/sources/dependencies.json`
- 변경 사항, 지원 환경, AI 런타임·모델 설치 조건

미디어 소스 압축에는 해당 FFmpeg·x264 소스, 사용한 빌드 스크립트·설정·관련 자료가 들어갑니다. 실행 파일과 대응 소스를 같은 릴리스 페이지에서 무료로 받을 수 있게 제공하고 본문에 소스 다운로드를 명시하세요. 패키지 안의 `resources/legal/`에 원래 라이선스와 구성요소 목록이 포함됩니다. 자세한 범위는 [외부 구성요소 안내](third-party-licenses.md)와 [미디어 빌드 안내](media-build.md)를 따릅니다.

## 자동 검사와 배포 후보

`.github/workflows/ci.yml`은 소스·이력 검사, Linux에서 Windows 미디어 빌드, Windows 설치·테스트를 수행합니다. `.github/workflows/release-candidate.yml`은 수동 실행하며 CI 통과 후 GPU 런타임과 앱을 빌드하고 실행 파일·앱 소스·미디어 대응 소스를 하나의 다운로드 아티팩트로 보관합니다. 두 워크플로 모두 저장소에 쓰기 권한이 없으며 릴리스를 자동 공개하지 않습니다. 실제 GitHub 실행 결과는 Actions에서 별도로 확인해야 합니다.

공개 직전에는 파일 목록과 해시를 확인하고, 릴리스와 대응 소스가 함께 접근 가능한지 확인합니다. GitHub 저장소 공개 전환, 태그 푸시와 Release 게시 자체는 이 로컬 준비 과정에서 수행하지 않습니다.
