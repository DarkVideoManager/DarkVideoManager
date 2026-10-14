# DarkVideoManager 구현 TODO

> README.md 기준 전체 구현 작업 분해표
> 마지막 업데이트: 2026-04-25

각 작업은 다음 형식으로 표기합니다.

- `[ ]` 미완료 / `[x]` 완료
- **L** = 레이어 (M=Main, R=Renderer, P=Preload, S=Shared, B=Build/CI, T=Test, D=Docs)
- **E** = 예상 난이도 (S=하루 이내, M=1~3일, L=1주 이상)
- **Dep** = 선행 작업 ID

---

## 목차

- [Phase 0. 프로젝트 부트스트랩](#phase-0-프로젝트-부트스트랩)
- [Phase 1. v0.1 MVP](#phase-1-v01-mvp)
- [Phase 2. v0.2 하이라이트 & 자막 고도화](#phase-2-v02-하이라이트--자막-고도화)
- [Phase 3. v0.3 통합 검색 & 자동화](#phase-3-v03-통합-검색--자동화)
- [Phase 4. v1.0 안정화 & 사용자 경험](#phase-4-v10-안정화--사용자-경험)
- [Future](#future)
- [횡단 관심사](#횡단-관심사)

---

## Phase 0. 프로젝트 부트스트랩

목표: 빈 저장소에서 `npm run dev`로 빈 Electron 창이 뜨는 상태까지.

### 0.1 저장소 및 툴체인
- [x] **0.1.1** [B/S] 저장소 생성, `.gitignore`, `.gitattributes`(`* text=auto eol=lf`), `LICENSE` placeholder
- [x] **0.1.2** [B] `package.json` 초기화, `engines.node = ">=18"`, `private: true`
- [x] **0.1.3** [B] `tsconfig.json` (strict), `tsconfig.node.json`, `tsconfig.web.json` 분리
- [x] **0.1.4** [B] ESLint(@typescript-eslint, react, react-hooks) + Prettier 설정
- [x] **0.1.5** [B] husky + lint-staged + commitlint(Conventional Commits) 설치
- [x] **0.1.6** [B] `.editorconfig`

### 0.2 Electron + Vite 셋업
- [x] **0.2.1** [B] `electron-vite` 도입, `electron.vite.config.ts` 작성 (main/preload/renderer 진입점)
- [x] **0.2.2** [M] `electron/main/index.ts` — `app.whenReady`, `BrowserWindow` 생성, 보안 옵션 적용
- [x] **0.2.3** [P] `electron/preload/index.ts` — `contextBridge.exposeInMainWorld('api', {})`
- [x] **0.2.4** [R] `src/renderer/main.tsx` + `App.tsx` — "Hello DarkVideoManager"
- [x] **0.2.5** [R] Tailwind CSS 초기화, 다크 테마 기본 (shadcn/ui는 Phase 1에서 추가)
- [x] **0.2.6** [B] `npm run dev`로 Electron 창 정상 실행 검증 ✅

### 0.3 패키지 매니저 / 네이티브 모듈
- [x] **0.3.1** [B] `better-sqlite3` package.json 등록, `electron-builder install-app-deps` postinstall 등록 (빌드 도구 설치 후 `npm run rebuild` 필요)
- [x] **0.3.2** [B] `ffmpeg-static`, `ffprobe-static` 설치, OS별 경로 감지 유틸 예정
- [x] **0.3.3** [B] `npm run rebuild` 스크립트 (electron-rebuild) 등록

> ⚠️ `better-sqlite3` 네이티브 빌드는 Python + Visual Studio Build Tools 필요.
> 설치 후 `npm run rebuild`로 Electron 전용 바이너리 빌드 필요.

### 0.4 빌드/패키징 골격
- [x] **0.4.1** [B] `electron-builder.yml` 작성 (Win NSIS + portable, asarUnpack)
- [x] **0.4.2** [B] `extraResources`로 ffmpeg 바이너리 동봉 설정
- [ ] **0.4.3** [B] `resources/icon.ico` 임시 아이콘 (추가 필요)
- [ ] **0.4.4** [B] `npm run build:win` 인스톨러 산출물 검증

### 0.5 CI 기본
- [x] **0.5.1** [B] `.github/workflows/ci.yml` (Windows runner, lint + typecheck + test)
- [x] **0.5.2** [B] PR 템플릿, 이슈 템플릿(`bug.md`, `feature.md`)

---

## Phase 1. v0.1 MVP

목표: 카테고리 생성 → 폴더 가져오기 → 그리드 표시 → 클릭 재생 → 별점/한줄평 저장.

### 1.1 공유 계층 (Shared)
- [ ] **1.1.1** [S] `src/shared/types.ts` — 도메인 타입 (Video, Library, Subtitle, ImportResult 등)
- [ ] **1.1.2** [S] `src/shared/ipc.ts` — `IPC` 채널 상수, 채널별 Zod 스키마
- [ ] **1.1.3** [S] `src/shared/result.ts` — `Result<T, E>` 패턴 (도메인 에러 타입화)

### 1.2 인프라 (Main)
- [ ] **1.2.1** [M] `infra/logger.ts` — pino + 일별 파일 로테이션, Renderer 측 forwarder
- [ ] **1.2.2** [M] `infra/config.ts` — `%APPDATA%\DarkVideoManager\config.json` 로드/저장
- [ ] **1.2.3** [M] `infra/paths.ts` — userData, cache, logs 디렉토리 헬퍼
- [ ] **1.2.4** [M] `infra/fs.ts` — 안전한 경로 조인, 화이트리스트 검증

### 1.3 데이터베이스 인프라
- [ ] **1.3.1** [M] `db/connection.ts` — better-sqlite3 인스턴스 풀 (라이브러리 ID → Database)
- [ ] **1.3.2** [M] DB pragma 설정 (`journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `cache_size`, `mmap_size`)
- [ ] **1.3.3** [M] `db/migrator.ts` — `migrations/*.sql` 순차 적용, `schema_version` 관리
- [ ] **1.3.4** [M] 마이그레이션 전 자동 백업(`<lib>.db.bak.<ts>`)
- [ ] **1.3.5** [M] 라이브러리 잠금 감지 (다중 인스턴스 → read-only fallback)

### 1.4 마이그레이션 (SQL)
- [ ] **1.4.1** [S] `migrations/001_init.sql` — `videos`, `thumbnails`, `play_history`, `subtitles`, `settings`, `schema_version`, 기본 인덱스
- [ ] **1.4.2** [S] `migrations/001` — `trg_play_history_insert` 트리거
- [ ] **1.4.3** [S] DB 통합 테스트로 `001_init.sql` 적용 검증

### 1.5 리포지토리 계층 (Main)
- [ ] **1.5.1** [M] `db/repositories/VideoRepository.ts` — CRUD, 페이지네이션 검색, 필터/정렬
- [ ] **1.5.2** [M] `db/repositories/ThumbnailRepository.ts`
- [ ] **1.5.3** [M] `db/repositories/SubtitleRepository.ts`
- [ ] **1.5.4** [M] `db/repositories/PlayHistoryRepository.ts`
- [ ] **1.5.5** [M] `db/repositories/SettingsRepository.ts` (key/value JSON)
- [ ] **1.5.6** [T] 각 리포지토리 Vitest 단위 테스트 (인메모리 SQLite)

### 1.6 FFmpeg 파이프라인
- [ ] **1.6.1** [M] `ffmpeg/ffmpegPath.ts` — packaged/dev 경로 분기
- [ ] **1.6.2** [M] `ffmpeg/ffprobe.ts` — 메타데이터 추출 (duration, width/height, codec, fps, bitrate, container)
- [ ] **1.6.3** [M] `ffmpeg/thumbnail.ts` — N장 자동 생성 (10/30/50/70/90%)
- [ ] **1.6.4** [M] `ffmpeg/queue.ts` — `p-queue` 기반 동시성 제한 (기본 2), AbortSignal 지원
- [ ] **1.6.5** [M] FFmpeg 진행률 → `progress` IPC 이벤트 푸시

### 1.7 서비스 계층
- [ ] **1.7.1** [M] `services/HashService.ts` — 단축 SHA-256 (앞 64MB + 뒤 64MB + size)
- [ ] **1.7.2** [M] `services/FsScanner.ts` — 동영상 확장자 화이트리스트, 재귀 스캔
- [ ] **1.7.3** [M] `services/LibraryService.ts` — open/create/close, 가져오기 오케스트레이션
- [ ] **1.7.4** [M] `services/VideoService.ts` — 검색, 메타 업데이트, 삭제
- [ ] **1.7.5** [M] `services/ThumbnailService.ts` — 생성 큐 + 캐시 경로 관리
- [ ] **1.7.6** [M] `services/PlaybackService.ts` — start/heartbeat/end, 90% 룰
- [ ] **1.7.7** [T] LibraryService 통합 테스트 (가짜 mp4 픽스처)

### 1.8 IPC 핸들러
- [ ] **1.8.1** [M] `ipc/library.ts` — list/open/create/close/importFolder
- [ ] **1.8.2** [M] `ipc/videos.ts` — search/get/updateMeta/delete
- [ ] **1.8.3** [M] `ipc/playback.ts` — start/heartbeat/end
- [ ] **1.8.4** [M] `ipc/thumbnails.ts` — generate/setPrimary
- [ ] **1.8.5** [M] `ipc/index.ts` — 핸들러 등록 + Zod 입력 검증 미들웨어
- [ ] **1.8.6** [M] 글로벌 에러 핸들러 (Result → IPC 응답 직렬화)

### 1.9 Preload
- [ ] **1.9.1** [P] `preload/api.ts` — invoke/on/off 화이트리스트, 채널 검증
- [ ] **1.9.2** [P] `preload/api.d.ts` — `window.api` 글로벌 타입 선언

### 1.10 Renderer 인프라
- [ ] **1.10.1** [R] React Router v6 셋업, 페이지 구조 정의
- [ ] **1.10.2** [R] Zustand 전역 스토어 골격 (현재 라이브러리, 선택된 영상)
- [ ] **1.10.3** [R] TanStack Query Provider, 기본 옵션 (staleTime 30s)
- [ ] **1.10.4** [R] `api/` 디렉토리 — `useVideos`, `useImportFolder` 등 훅 작성
- [ ] **1.10.5** [R] `mock/` — 브라우저 단독 모드용 IPC mock (`VITE_MOCK_IPC=true`)

### 1.11 Renderer UI
- [ ] **1.11.1** [R] 메인 레이아웃: 사이드바 + 헤더 + 컨텐츠 + 우측 패널 + 하단 도크
- [ ] **1.11.2** [R] 사이드바: 라이브러리 목록, "새 카테고리", "라이브러리 열기"
- [ ] **1.11.3** [R] 가져오기 다이얼로그: 폴더 선택, 진행률 표시
- [ ] **1.11.4** [R] 그리드 뷰: `@tanstack/react-virtual`로 가상화, 썸네일 + 제목 + 별점
- [ ] **1.11.5** [R] 리스트 뷰 토글
- [ ] **1.11.6** [R] 상세 패널: 메타데이터, 별점 입력, 한줄평 textarea(자동 저장 디바운스 500ms)
- [ ] **1.11.7** [R] 플레이어 페이지: HTML5 `<video>` + Plyr UI 래핑
- [ ] **1.11.8** [R] 외부 SRT 자막 자동 매칭 + `<track>` 등록
- [ ] **1.11.9** [R] heartbeat 타이머 (5초 간격) + unmount/close 시 end 호출

### 1.12 MVP 검증
- [ ] **1.12.1** [T] E2E: 빈 라이브러리 → `.db` 생성 → 폴더 가져오기 → 그리드 검증
- [ ] **1.12.2** [T] E2E: 영상 클릭 → 재생 → 5초 후 종료 → 이어보기 위치 저장
- [ ] **1.12.3** [T] E2E: 별점/한줄평 변경 → 앱 재시작 → 유지 검증
- [ ] **1.12.4** [D] README "사용 방법" 섹션 스크린샷 업데이트
- [ ] **1.12.5** [B] v0.1.0 태그 생성, GitHub Release 첫 인스톨러 배포

---

## Phase 2. v0.2 하이라이트 & 자막 고도화

목표: 하이라이트 시스템, 다중 자막 트랙, 통계 대시보드.

### 2.1 마이그레이션
- [ ] **2.1.1** [S] `migrations/002_highlights_color.sql` — `highlights.color` 컬럼 추가 (이미 001에 포함됐다면 SKIP)
- [ ] **2.1.2** [S] `migrations/003_subtitle_tracks.sql` — embedded 트랙 인덱스 컬럼

### 2.2 하이라이트 (Main)
- [ ] **2.2.1** [M] `services/HighlightService.ts` — CRUD, 시간순 정렬
- [ ] **2.2.2** [M] `db/repositories/HighlightRepository.ts`
- [ ] **2.2.3** [M] `ipc/highlights.ts`
- [ ] **2.2.4** [T] 하이라이트 단위/통합 테스트

### 2.3 하이라이트 (Renderer)
- [ ] **2.3.1** [R] 플레이어 하단 타임라인에 하이라이트 마커 표시
- [ ] **2.3.2** [R] 단축키 `H` 단일 시점, `Shift+H` 구간 시작/종료
- [ ] **2.3.3** [R] 우측 패널 "하이라이트" 탭 — 목록, 인라인 편집
- [ ] **2.3.4** [R] 하이라이트 클릭 → 해당 시점 점프 + (옵션) 자동 일시정지
- [ ] **2.3.5** [R] 색상 태그 선택 UI

### 2.4 자막 고도화 (Main)
- [ ] **2.4.1** [M] `services/SubtitleService.ts` — 인코딩 감지(`chardet` + 한국어 휴리스틱)
- [ ] **2.4.2** [M] SMI 파서 → VTT 변환기 작성
- [ ] **2.4.3** [M] ffprobe로 내장 자막 트랙 메타데이터 추출
- [ ] **2.4.4** [M] FFmpeg로 내장 자막을 VTT로 추출 (요청 시 임시 파일)

### 2.5 자막 고도화 (Renderer)
- [ ] **2.5.1** [R] JASSUB 통합 (Web Worker + WebAssembly), ASS/SSA 렌더링
- [ ] **2.5.2** [R] 자막 트랙 전환 메뉴 (외부/내장/없음)
- [ ] **2.5.3** [R] 싱크 조정 UI (`[`/`]` 키, ±100ms)
- [ ] **2.5.4** [R] 폰트/크기/색상 커스터마이즈 (SRT/VTT)
- [ ] **2.5.5** [R] 인코딩 수동 지정 폴백 (자동 감지 실패 시)

### 2.6 통계 대시보드
- [ ] **2.6.1** [M] 집계 쿼리: 일/주/월별 시청 시간, 카테고리별 분포, 상위 영상
- [ ] **2.6.2** [M] `services/StatsService.ts` + IPC
- [ ] **2.6.3** [R] 통계 페이지 — recharts 기반 막대/라인/도넛 차트
- [ ] **2.6.4** [R] 기간 필터 (7d / 30d / All)

### 2.7 검증 / 릴리스
- [ ] **2.7.1** [T] E2E: 하이라이트 추가 → 재시작 → 마커 유지
- [ ] **2.7.2** [T] E2E: ASS 자막 영상 재생 → 스타일 보존 검증
- [ ] **2.7.3** [B] v0.2.0 릴리스

---

## Phase 3. v0.3 통합 검색 & 자동화

목표: FTS5 통합 검색, 누락 파일 재연결, 파일 워처, 자동 업데이트.

### 3.1 FTS5 통합 검색
- [ ] **3.1.1** [S] `migrations/004_fts5.sql` — `videos_fts` 가상 테이블 + 동기화 트리거(insert/update/delete)
- [ ] **3.1.2** [M] `services/SearchService.ts` — FTS5 쿼리, 다중 라이브러리 통합
- [ ] **3.1.3** [M] 한국어 토큰화 검토 (unicode61 한계 → 필요 시 사용자 정의 토크나이저)
- [ ] **3.1.4** [R] 통합 검색 UI (Cmd+K 팔레트 스타일)
- [ ] **3.1.5** [R] 검색 결과 — 라이브러리 라벨 표시
- [ ] **3.1.6** [T] FTS5 쿼리 단위 테스트 (한/영 혼용)

### 3.2 누락 파일 재연결
- [ ] **3.2.1** [M] `services/MissingFileService.ts` — `is_missing=1` 영상에 대해 후보 검색
- [ ] **3.2.2** [M] 해시 매칭 우선, 동일 파일명 fallback
- [ ] **3.2.3** [R] 재연결 마법사 UI — 후보 목록, 일괄 적용

### 3.3 파일 워처
- [ ] **3.3.1** [M] `services/LibraryWatcher.ts` — chokidar, `awaitWriteFinish`
- [ ] **3.3.2** [M] 새 파일 감지 → 자동 가져오기 (옵션)
- [ ] **3.3.3** [M] 삭제 감지 → `is_missing=1` 마킹 (자동 삭제는 하지 않음)
- [ ] **3.3.4** [M] 디바운스 + 배치 처리
- [ ] **3.3.5** [R] 라이브러리 설정에서 워처 on/off 토글

### 3.4 자동 업데이트
- [ ] **3.4.1** [M] `electron-updater` 통합, GitHub Releases 채널
- [ ] **3.4.2** [M] 업데이트 확인 주기 (24h), 사용자 동의 후 다운로드
- [ ] **3.4.3** [R] 업데이트 가능 알림 토스트 + "지금 다시 시작" 버튼
- [ ] **3.4.4** [B] `release.yml` 워크플로우에 `publish` 활성화

### 3.5 외부 메타데이터 강화
- [ ] **3.5.1** [M] HDR 메타데이터(BT.2020, HDR10) 표시
- [ ] **3.5.2** [M] 챕터 정보(MKV) 추출 → 하이라이트 자동 생성 옵션
- [ ] **3.5.3** [R] 영상 상세 패널 "기술 정보" 섹션

### 3.6 검증 / 릴리스
- [ ] **3.6.1** [T] E2E: 통합 검색 한/영 키워드
- [ ] **3.6.2** [T] E2E: 파일 이동 → 누락 표시 → 마법사로 재연결
- [ ] **3.6.3** [B] v0.3.0 릴리스

---

## Phase 4. v1.0 안정화 & 사용자 경험

목표: 테마/단축키/다국어/접근성, E2E 커버리지 80%+.

### 4.1 테마 / 사용자 정의
- [ ] **4.1.1** [R] 라이트/다크/시스템 테마, CSS 변수 토큰화
- [ ] **4.1.2** [R] 단축키 매핑 편집기 (충돌 검증 포함)
- [ ] **4.1.3** [R] 그리드 카드 크기 / 컬럼 수 조절 슬라이더
- [ ] **4.1.4** [R] 플레이어 외관 옵션 (자막 폰트, 컨트롤바 자동 숨김 시간)

### 4.2 다국어 (i18n)
- [ ] **4.2.1** [R] `react-i18next` 도입, `locales/ko.json`, `locales/en.json`
- [ ] **4.2.2** [R] 모든 UI 문자열 i18n key로 추출
- [ ] **4.2.3** [R] 언어 자동 감지 + 사용자 선택 오버라이드

### 4.3 설정 가져오기/내보내기
- [ ] **4.3.1** [M] 설정 + 라이브러리 목록 JSON export
- [ ] **4.3.2** [M] import 시 충돌 해소 (덮어쓰기/병합)
- [ ] **4.3.3** [R] 설정 페이지 UI

### 4.4 접근성
- [ ] **4.4.1** [R] 키보드 전용 내비게이션 (Tab 순서, 포커스 트랩)
- [ ] **4.4.2** [R] ARIA 레이블 / 역할 부여
- [ ] **4.4.3** [R] 고대비 테마 지원
- [ ] **4.4.4** [T] axe-core 자동 검증

### 4.5 안정화
- [ ] **4.5.1** [T] Vitest 단위 테스트 커버리지 80%+
- [ ] **4.5.2** [T] Playwright E2E 핵심 시나리오 20+ 케이스
- [ ] **4.5.3** [M] Sentry 또는 자체 크래시 리포터 (옵트인)
- [ ] **4.5.4** [M] 메모리 누수 점검 (장시간 재생, 라이브러리 전환 반복)
- [ ] **4.5.5** [B] 코드 사이닝 (Windows EV 인증서) 검토
- [ ] **4.5.6** [D] 사용자 매뉴얼 / FAQ 작성

### 4.6 v1.0 릴리스
- [ ] **4.6.1** [B] CHANGELOG.md 정리
- [ ] **4.6.2** [B] 라이선스 확정 (FFmpeg 호환성 검토)
- [ ] **4.6.3** [B] v1.0.0 릴리스, 공식 다운로드 페이지

---

## Future

순서 미정, 별도 RFC로 진행.

- [ ] **F.1** macOS 빌드 (Apple Silicon + Intel) 및 코드 사이닝/공증
- [ ] **F.2** Linux 빌드 (AppImage / deb / rpm)
- [ ] **F.3** 모바일 동기화 — 메타데이터만(별점/한줄평/하이라이트), CRDT(Automerge/Yjs) 검토
- [ ] **F.4** AI 장면 자동 태깅 (CLIP 기반 로컬 모델) — 옵트인
- [ ] **F.5** AI 썸네일 추천 (SceneDetect + 미적 점수)
- [ ] **F.6** 플러그인 시스템 — 외부 자막 소스, 메타데이터 보강 어댑터
- [ ] **F.7** 클라우드 백업 — 사용자 선택 S3/GDrive에 `.db` 암호화 업로드

---

## 횡단 관심사

### 보안
- [ ] **X.1** Electron Fuses 활성화 (`runAsNode=false`, `enableNodeOptionsEnvironmentVariable=false` 등)
- [ ] **X.2** CSP 강화 검증 (`default-src 'self'; media-src 'self' file:; img-src 'self' file: data:`)
- [ ] **X.3** Renderer에서 `shell.openExternal` 호출은 화이트리스트 도메인만 허용
- [ ] **X.4** IPC 입력 Zod 검증 100% 적용
- [ ] **X.5** 파일 경로 traversal 방어 (등록된 라이브러리 루트 하위인지 검증)

### 성능
- [ ] **X.6** 그리드 10만 건 시뮬레이션 + 60fps 검증
- [ ] **X.7** 가져오기 1만 건 시 메모리/시간 프로파일링
- [ ] **X.8** 썸네일 LRU `ImageBitmap` 캐시 메모리 상한 설정
- [ ] **X.9** DB prepared statement 캐시 적중률 측정
- [ ] **X.10** 자막 ASS 렌더링 Web Worker 분리 (메인 스레드 잠김 방지)

### 관측성
- [ ] **X.11** 구조화 로깅 (pino), 요청 ID 전파
- [ ] **X.12** 사용자가 "버그 리포트" 클릭 시 최근 로그 + 시스템 정보 zip 패키징
- [ ] **X.13** 옵트인 익명 사용 통계 (기능 사용 빈도)

### 개발자 경험
- [ ] **X.14** Storybook 또는 Ladle 도입 (UI 컴포넌트 격리 개발)
- [ ] **X.15** 가짜 mp4 픽스처 생성 스크립트 (`scripts/gen-fixtures.ts`)
- [ ] **X.16** `npm run db:inspect <path>` — DB CLI 진단 도구
- [ ] **X.17** VS Code `.vscode/launch.json` — Main/Renderer 동시 디버깅 설정
- [ ] **X.18** PR 템플릿에 "스크린샷 첨부", "마이그레이션 추가 시 명시" 체크리스트

### 문서
- [ ] **X.19** `docs/architecture.md` — 상세 다이어그램, 결정 기록(ADR)
- [ ] **X.20** `docs/db-schema.md` — 최신 스키마 자동 추출 스크립트
- [ ] **X.21** `docs/ipc-contracts.md` — 채널별 입출력 명세
- [ ] **X.22** `docs/contributing.md`

---

## 작업 순서 가이드

권장 진행 순서는 다음과 같습니다.

1. **Phase 0 전체** — 1~2일 내 끝내고 빠르게 다음 단계로
2. **1.1 → 1.2 → 1.3 → 1.4 → 1.5** (DB/리포지토리 기반 먼저 완성)
3. **1.6 → 1.7 → 1.8 → 1.9** (FFmpeg + 서비스 + IPC)
4. **1.10 → 1.11** (Renderer 인프라 + UI)
5. **1.12 검증 후 v0.1 태깅**
6. **Phase 2 → 3 → 4 순차 진행**, 각 단계 종료 후 릴리스

병렬화 가능한 지점:
- 1.4 (마이그레이션) ↔ 1.6 (FFmpeg) — 같은 사람이 아니어도 됨
- 1.10/1.11 (Renderer)는 mock IPC로 1.7~1.9 완료 전이라도 시작 가능

---

## 진행 상황 기록 규칙

- 작업을 시작할 때 `[ ]` → `[~]` (in-progress 표시는 선택)
- 완료 시 `[x]`, 옆에 PR 번호 또는 커밋 SHA 주석
- Phase 종료 시 README의 "개발 로드맵" 섹션 체크 상태와 동기화
- 새 작업 추가 시 ID는 해당 섹션 마지막 번호 + 1 (재번호 금지)