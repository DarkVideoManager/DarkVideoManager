# TODO / DarkVideoManager

> 칸반 원본: 이 파일의 open task를 별도로 사용하는 프로젝트 칸반 도구에 표시한다.
> 분석 기준일: 2026-09-07
> 상태 신호: TODO: 0.4.3 이후 미완료 다수

이 파일은 이 프로젝트의 현재 남은 작업을 기록한다. 기존 설계서·로드맵·세부 TODO는 보존하며, 작업이 끝나면 해당 항목을 `[x]`로 바꾸고 근거를 남긴다.

## Open queue

- [ ] [P1] [BLOCKED] Phase 0.4.3 임시 icon.ico와 Windows installer 산출물 <!-- id=dark-icon; size=S; confidence=direct; tags=bootstrap,release; source=DarkVideoManager/docs/TODO.md §0.4.3–0.4.4 -->
  > 차단: 코드 번들은 성공했지만 Linux 환경에 `wine`이 없어 `electron-builder --win`이 NSIS/portable 패키징 단계에서 `ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`로 중단됐다.
  > 구현: `resources/icon.ico`(16/32/48/256px, Windows ICO) 추가, `electron-builder.yml`에 아이콘·NSIS/portable x64 target 연결.
  > 확인: `file resources/icon.ico`, `npm run build` 통과; `npm run build:win`은 wine 미설치로 실패; `npm run typecheck` 통과; `npm run lint`는 기존 `jsx-a11y/media-has-caption` rule 누락으로 실패; `npm test -- --run`은 test script 부재로 실패.
  > 재개 조건: Wine 또는 Windows CI 환경에서 `npm run build:win`을 실행해 NSIS installer와 portable 산출물 존재를 확인한다.

- [x] [P1] [DONE] Shared 도메인 타입·IPC 채널·Result 계약 만들기 <!-- id=dark-shared; size=M; confidence=direct; tags=mvp,contract; source=DarkVideoManager/docs/TODO.md §1.1.1–1.1.3 -->
  > 구현: 기존 도메인 타입을 유지하고 IPC 23개 invoke/2개 event 채널에 Zod tuple/object schema를 추가했으며, 중복 채널 export를 제거했다. `Result` 기본 에러와 DomainError 코드·생성·정규화 계약도 추가했다.
  > 보정: `electron/preload/index.ts`의 중복 API 정의를 제거하고 Node tsconfig에 shared 파일을 포함했다.
  > 확인: `npm run typecheck`, `npx eslint src/shared --ext .ts`, `npm test -- --run`의 shared 4개 계약 테스트 통과.

- [x] [P1] [DONE] SQLite connection·migration·repository 계층 구현 <!-- id=dark-db; size=L; confidence=direct; tags=sqlite,data; source=DarkVideoManager/docs/TODO.md §1.3–1.5 -->
  > 구현: library-id DB pool에 WAL/NORMAL/foreign_keys/cache/mmap pragma, sidecar lock 기반 read-only fallback, close 시 lock 해제를 추가했다. `001_init.sql`/`002_highlights.sql` 파일 migration, 트랜잭션 적용, 자동 `.bak.<timestamp>` 백업, schema version, play-history trigger를 연결하고 repository의 thumbnail primary 원자성/소속 검증을 보강했다.
  > 확인: `npm test -- --run`의 SQLite migration/connection 및 5개 repository 시나리오 7개 테스트, `npm run typecheck:node`, `npx eslint electron/main/db --ext .ts` 통과. Node ABI용 `better-sqlite3` 재빌드 후 실제 lock/read-only fallback도 통과했다.

- [x] [P1] [DONE] FFmpeg import·thumbnail queue·progress IPC 수직 슬라이스 <!-- id=dark-ffmpeg; size=L; confidence=direct; tags=ffmpeg,pipeline; source=DarkVideoManager/docs/TODO.md §1.6–1.7 -->
  > 구현: ffmpeg/ffprobe 경로·메타데이터 정규화, 10/30/50/70/90% 썸네일 생성(출력 디렉터리/부분 파일 정리), AbortSignal, 동시성 2 큐, LibraryService의 thumbnails/done progress IPC와 thumbnail-ready 이벤트를 연결했다.
  > 확인: `npm test -- --run`의 shared/DB/FFmpeg 14개 테스트, `npm run typecheck:node`, `npm run typecheck:web`, `npx eslint electron/main/ffmpeg electron/main/services/LibraryService.ts` 통과. 실제 ffprobe, 5장 JPEG 생성·progress, queue 취소 동작도 통과했다.

- [ ] [P1] [BLOCKED] MVP UI·IPC·E2E 수용 게이트 정의 <!-- id=dark-mvp; size=L; confidence=direct; tags=electron,e2e; source=DarkVideoManager/docs/TODO.md §1.8–1.12 -->
  > 구현: shared Zod 입력 schema를 모든 main IPC handler wrapper에 연결하고 preload 이벤트 unsubscribe 반환 타입을 정리했다. Renderer Router/Zustand/TanStack Query UI에 VITE_MOCK_IPC 브라우저 mock, 라이브러리·검색·그리드·import progress·상세/플레이어 흐름을 연결했다.
  > 보정: 중복 preload API 제거, WindowApi 전역 타입 연결, progress 완료 판정을 `phase === 'done'`으로 수정했다.
  > 확인: `npm run typecheck`, `npm run typecheck:node`, `npm run typecheck:web`, `npm run lint`, `npm run build`, `npm run test:e2e`의 Playwright mock-IPC UI 흐름 1개 통과. Demo Library 선택→sample grid→player→별점/메모 재시작→import 완료를 실제 Chromium에서 확인했다.
  > 차단: 빈 DB를 생성하는 Electron fixture와 실제 better-sqlite3 IPC 재시작 E2E가 아직 없어 원문 수용 게이트(빈 DB→가져오기→그리드, 재생 위치 복원)를 완료 처리하지 않았다.

## Maintenance notes

- `DOC` 항목은 원본 문서에 직접 남아 있는 작업이다.
- `INFERRED` 항목은 현재 운영·검증 신호에서 도출한 다음 단계이며, 실행 전에 담당자가 범위를 확정한다.
- 비밀값·토큰·쿠키·원본 입력은 이 파일에 기록하지 않는다.

