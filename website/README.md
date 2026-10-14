# DarkVideoManager 소개 웹사이트

한국어 반응형 소개 페이지와 실제 앱의 React 화면을 재사용하는 브라우저 체험판입니다. 공개 사용이 가능한 야구 샘플 영상을 포함하며, 개인 데이터나 Windows 설치 파일은 포함하지 않습니다.

공개 주소: https://dark-video-manager.vercel.app/

## 로컬 실행

저장소 루트의 의존성을 설치한 상태에서 이 폴더의 `npm run build:demo`로 실제 앱 화면을 `public/demo`에 빌드합니다. `npm run dev` 실행 후 http://127.0.0.1:4178 을 엽니다. 체험판만 보려면 `/demo/`를 엽니다.

`demo/main.tsx`는 실제 `src/renderer/App`과 스타일을 불러옵니다. `demo/api.ts`는 Electron 통신 대신 브라우저 저장소와 영상 캡처, 자막 생성 시뮬레이션을 제공합니다. 자막 생성은 약 15초의 진행 과정과 일시정지·재개·취소·재생성, 예시 VTT 저장을 체험하는 기능이며 실제 AI 추론을 하지 않습니다. 자막은 수작업 장면 설명이고 모델 선택에 따른 품질 차이는 없습니다. 실제 설치·클라우드 키 설정 UI는 브라우저 전용 체험 카드로 대체합니다. `demo/browser-copy.ts`의 빌드 시 문구 변환은 실제 앱 코드나 Windows 빌드를 수정하지 않습니다.

초기 통계·별점·메모·하이라이트·완료된 자막 작업은 예시 데이터임을 화면에 표시합니다. 이후 조작과 결과는 브라우저에 저장되며 새로고침 시 미완료 작업은 일시정지 상태로 복원합니다. 기존 저장 데이터는 사용자 변경사항을 보존하며 마이그레이션합니다. 저장소가 막히거나 가득 찬 경우 완료로 가장하지 않고 오류를 표시합니다.

브라우저 플레이어는 W로 재생·일시정지, A/D로 1초 탐색(Shift는 5초), S로 현재 장면의 하이라이트와 캡처를 저장합니다. A/D/S는 실제 앱의 동작을 재사용하며 W는 브라우저 체험용 별칭입니다. 화면의 WASD 버튼은 터치로도 누를 수 있습니다. 한글 키보드의 물리 키 위치를 지원하며 입력창·편집 영역·대화상자에서는 조작하지 않고 Ctrl/Alt/Command 조합은 브라우저에 맡깁니다.

Q/E는 이전·다음 하이라이트, Z/C는 선택한 자막의 이전·다음 구간으로 이동합니다. 실제 앱의 탐색 동작을 재사용하며 자막 항목을 선택한 뒤에도 사용할 수 있습니다. 화면 키 안내에 클릭 가능한 버튼과 눌림 표시를 제공하고, 이동할 항목이 없으면 기존 플레이어의 안내를 표시합니다.

## 배포

먼저 `npm run build:demo`를 실행하고 Vercel에 **website 폴더만** 배포합니다. `vercel.json`은 프레임워크 없이 `public`을 정적 배포합니다. 저장소 전체나 Electron 빌드/검증 폴더는 업로드하지 않습니다. `.env*`는 배포 및 Git에서 제외합니다.

소스 저장소: https://github.com/DarkVideoManager/DarkVideoManager

Windows 설치 파일과 포터블 파일은 [v0.2.2 릴리스](https://github.com/DarkVideoManager/DarkVideoManager/releases/tag/v0.2.2)에서 배포합니다. 소개 페이지의 다운로드 링크는 해당 릴리스의 `DarkVideoManager-Setup-0.2.2-x64.exe`와 `DarkVideoManager-Portable-0.2.2-x64.exe`를 가리킵니다. 설치 파일은 안내에 따라 설치하고, 포터블 파일은 설치 없이 실행합니다. 소스 압축 파일은 개발용 코드이며 설치 파일이 아닙니다.

생성된 `public/demo` 번들은 Git에 포함하지 않으므로 배포 전 `npm run build:demo`를 실행하세요. 자동 설치 검증 상태 문구는 실제 결과가 확인된 후 갱신하세요.

외부 글꼴, 분석 도구, 쿠키, 외부 이미지 요청은 사용하지 않습니다. 영상과 썸네일도 직접 호스팅합니다. D. Benjamin Miller의 CC0 영상과 NARA가 제공하는 퍼블릭 도메인 기록 영상을 사용합니다. 개별 출처와 변환 기록은 `public/media-credits.html` 및 `public/demo-media/media-manifest.json`에 있습니다. 원본 아이콘은 프로젝트의 권한 확인된 아이콘입니다. 로컬 처리 안내는 README.md와 docs/PRIVACY.md, 설치 요구사항은 docs/subtitles.md를 기준으로 작성했습니다.
