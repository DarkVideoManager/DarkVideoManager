# 과거 설계·개발 기록

이 파일은 공개 준비 전 문서를 보존한 이력 자료입니다. 미구현 기능과 오래된 설치·배포 예시가 포함되어 있으며, 현재 사용법은 루트 README.md를 따릅니다.

# 동영상 관리 프로그램 (DarkVideoManager)

> Electron + React + TypeScript 기반 Windows 데스크톱 동영상 라이브러리 매니저

## 배포본 기능 복구 버전

제공된 Windows 배포본 `app.asar`의 기능을 기존 프로젝트에 복구했습니다. 복원된 화면은 JSX,
공유 계약·저장소·주요 서비스는 TypeScript이며, 일부 배포 전용 서비스는 JavaScript와 타입 선언으로 구성합니다.
현재 실행·검증 방법과 복구 범위는 [복구 안내](docs/restoration.md)를 기준으로 확인하세요.
복구 후 설정 백업·복원, 휴지통/목록 제거와 복구, 가져오기 진행률·취소, 대용량 검색 개선,
재생 캐시 용량 관리, 외부 플레이어 선택과 실행 오류 처리를 추가했습니다.
연속 탐색은 디코딩 완료에 맞춰 요청을 합치고, 최대 5초 가속 이동과 최종 위치의 정확도를 유지합니다.
설정에서 인앱 GPU 가속 지원 상태를 확인할 수 있으며, mpv 실행 시에도 하드웨어 디코더를 자동 선택합니다.
Windows Vulkan GPU 음성 인식과 Google Cloud/Ollama 한국어 번역으로 AI 자막을 생성하고 선택할 수 있습니다. [자막 생성 안내](docs/subtitles.md)를 참고하세요.
자막 생성 탭에서 대기열을 일시정지·재개·삭제할 수 있으며, 작업이 남아 있으면 창을 닫아도 트레이에서 계속 처리합니다.
라이브러리 상단의 **자막 없는 영상만**을 체크하면 등록된 자막이 없는 영상만 검색·정렬할 수 있습니다. 필터는 라이브러리별로 기억되며, AI 자막 생성이 완료된 영상은 필터 결과에서 자동으로 빠집니다.
플레이어 오른쪽의 **자막 탐색** 탭에서 SRT·VTT·SMI 자막 내용을 검색하고, 문장을 클릭해 해당 시작 시간으로 이동할 수 있습니다. 인앱 재생 시 **현재 자막** 버튼은 재생 중인 문장을 목록에서 찾아주며, 탐색할 자막 선택은 화면에 표시되는 자막과 연동됩니다.
인앱 재생용 영상 변환도 한 번에 하나씩 대기열로 처리합니다. 홈 화면에서 대기 순서와 실제 변환 진행률을 확인하고 일시정지·재개·삭제할 수 있습니다. 홈으로 돌아가거나 창을 닫아도 작업이 계속되며, 완전히 종료한 뒤에는 일시정지 상태로 복구됩니다. 변환 재개는 해당 영상을 처음부터 다시 처리하고, 대기열 삭제는 원본 영상이나 완료된 변환본을 삭제하지 않습니다.
인앱 플레이어는 4:3·세로·와이드 영상의 원본 비율을 유지하면서 창 크기에 맞춰 표시하며, 창 크기나 상세 패널 표시를 바꿔도 재생 조작부와 하이라이트 목록이 화면 안에 유지됩니다.
통계 화면은 7·30·90·365일 시청 추이와 직전 동일 기간 대비 변화, 요일·재생 시작 시간대별 패턴, 현재 보유 영상 순위를 보여줍니다. 영상 수·용량·길이와 해상도·별점·형식·태그 분포, 미시청·자막·한국어/AI 자막·하이라이트 보유 현황도 확인할 수 있습니다. 기간별 시청 통계는 실제 시청 시간이 기록된 재생을 로컬 시작 날짜에 합산하며, 목록에서 제거한 영상의 보존된 시청 이력도 포함합니다. 보유 현황과 영상 순위는 현재 목록 기준이며, 자막 현황은 라이브러리에 등록된 자막 기준입니다.
아래의 기존 설계 문서에는 아직 구현되지 않은 로드맵도 포함되어 있습니다.

```powershell
npm run setup
npm run build
npm test
npm run dev
```

Windows 실행 폴더 생성: `npm run build:unpacked` → `dist-electron/win-unpacked/DarkVideoManager.exe`.
`setup`은 Electron 31.7.7용 SQLite 모듈을 설치하므로 별도 Visual C++ 빌드 도구가 필요하지 않습니다.

흩어져 있는 동영상 파일을 카테고리 단위로 묶고, 썸네일·하이라이트·별점·한줄평까지 한 곳에서 관리할 수 있도록 설계된 개인용 동영상 라이브러리 매니저입니다. 카테고리별 `.db` 파일 단위로 데이터를 분리 보관해 백업과 이동이 자유롭습니다.

[![Electron](https://img.shields.io/badge/Electron-28%2B-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-fluent--ffmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)

---

## 목차

1. [프로젝트 개요](#프로젝트-개요)
2. [기술 스택](#기술-스택)
3. [아키텍처](#아키텍처)
4. [주요 기능](#주요-기능)
5. [지원 환경](#지원-환경)
6. [지원 포맷](#지원-포맷)
7. [데이터 구조 및 스키마](#데이터-구조-및-스키마)
8. [IPC 인터페이스](#ipc-인터페이스)
9. [FFmpeg 파이프라인](#ffmpeg-파이프라인)
10. [보안 모델](#보안-모델)
11. [성능 최적화 전략](#성능-최적화-전략)
12. [개발 환경 설정 및 빌드](#개발-환경-설정-및-빌드)
13. [테스트 전략](#테스트-전략)
14. [CI / 릴리스](#ci--릴리스)
15. [사용 방법](#사용-방법)
16. [디렉토리 구조](#디렉토리-구조)
17. [화면 구성 및 단축키](#화면-구성-및-단축키)
18. [개발 로드맵](#개발-로드맵)
19. [트러블슈팅](#트러블슈팅)
20. [라이선스](#라이선스)

---

## 프로젝트 개요

수백, 수천 개의 동영상 파일이 폴더 곳곳에 흩어져 있을 때 "예전에 봤던 그 장면"을 다시 찾는 일은 결코 쉽지 않습니다. **DarkVideoManager**는 다음을 하나의 도구로 해결합니다.

- 폴더 구조에 묶이지 않는 **카테고리 기반 분류** (`.db` = 카테고리)
- 한눈에 알아볼 수 있는 **썸네일 미리보기**
- 영상 내 인상 깊은 구간을 표시하는 **하이라이트(타임코드 북마크)**
- **별점 · 재생 횟수 · 한줄평** 메타데이터 기반 큐레이션
- 외장하드/클라우드로 옮겨도 깨지지 않는 **휴대 가능한 SQLite 라이브러리**

설계 원칙은 단순합니다.

1. **데이터 휴대성** — 라이브러리는 단일 SQLite 파일. 메타데이터는 영상 파일에 종속되지 않고, 영상은 절대경로 + 콘텐츠 해시로 추적합니다.
2. **로컬 우선** — 인터넷 연결 없이 100% 동작하며, 외부 API 의존성이 없습니다.
3. **Renderer는 무지(無知)** — UI는 IPC 계약 외엔 어떤 시스템 자원에도 직접 접근하지 않습니다. 보안과 테스트 가능성을 동시에 확보합니다.

---

## 기술 스택

### 런타임 / 프레임워크

| 분류          | 기술                                            | 버전  | 비고                                |
| ------------- | ----------------------------------------------- | ----- | ----------------------------------- |
| 앱 셸         | [Electron](https://www.electronjs.org/)         | 28.x+ | Chromium 120+ / Node.js 18+ 내장    |
| 빌드 도구     | [electron-vite](https://electron-vite.org/)     | 2.x   | Main / Preload / Renderer 통합 빌드 |
| 번들러        | [Vite](https://vitejs.dev/)                     | 5.x   | Renderer HMR                        |
| 패키저        | [electron-builder](https://www.electron.build/) | 24.x  | NSIS 인스톨러 + 포터블              |
| UI            | React                                           | 18.x  | Concurrent Features, Suspense       |
| 언어          | TypeScript                                      | 5.x   | `strict: true`                      |
| 패키지 매니저 | npm                                             | 9.x+  | 단일 lockfile 정책                  |

### Renderer 의존성

| 분류            | 라이브러리                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| 상태 관리       | [Zustand](https://github.com/pmndrs/zustand) (전역) + [TanStack Query](https://tanstack.com/query) (IPC 캐시) |
| 라우팅          | [React Router](https://reactrouter.com/) v6                                                                   |
| 스타일링        | [Tailwind CSS](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/)                                |
| 가상화 리스트   | [@tanstack/react-virtual](https://tanstack.com/virtual)                                                       |
| 동영상 플레이어 | HTML5 `<video>` + [Plyr](https://plyr.io/) (커스터마이즈)                                                     |
| 자막 렌더링     | [JASSUB](https://github.com/ThaUnknown/jassub) (ASS/SSA) + 자체 SRT 렌더러                                    |
| 폼 / 검증       | [React Hook Form](https://react-hook-form.com/) + [Zod](https://zod.dev/)                                     |
| 아이콘          | [lucide-react](https://lucide.dev/)                                                                           |

### Main 의존성

| 분류          | 라이브러리                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB            | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (동기 API, WAL 모드)                                                                                                                         |
| 마이그레이션  | 자체 SQL 마이그레이터 (`migrations/*.sql`)                                                                                                                                                                |
| 동영상 처리   | [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) + [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) + [ffprobe-static](https://github.com/joshwnj/node-ffprobe-installer) |
| 인코딩 감지   | [chardet](https://github.com/runk/node-chardet) (자막 인코딩)                                                                                                                                             |
| 파일 워처     | [chokidar](https://github.com/paulmillr/chokidar) (라이브러리 폴더 감시)                                                                                                                                  |
| 해시          | Node 내장 `crypto` (SHA-256, BLAKE3는 옵션)                                                                                                                                                               |
| 로거          | [pino](https://getpino.io/) + 일별 파일 로테이션                                                                                                                                                          |
| 자동 업데이트 | [electron-updater](https://www.electron.build/auto-update)                                                                                                                                                |

### 개발 도구

| 분류          | 도구                                                 |
| ------------- | ---------------------------------------------------- |
| 린터          | ESLint (`@typescript-eslint`, `eslint-plugin-react`) |
| 포맷터        | Prettier                                             |
| 테스트 (단위) | Vitest                                               |
| 테스트 (E2E)  | Playwright + `@playwright/test` (Electron 모드)      |
| 커밋 훅       | husky + lint-staged                                  |
| 커밋 컨벤션   | Conventional Commits + Commitlint                    |

---

## 아키텍처

### 프로세스 구성

```
┌───────────────────────────────────────────────────────────────────────┐
│                              Electron App                             │
│                                                                       │
│  ┌──────────────────────┐   IPC    ┌─────────────────────────────┐    │
│  │   Main Process       │◄────────►│   Renderer Process          │    │
│  │   (Node.js 18+)      │          │   (Chromium / React)        │    │
│  │                      │          │                             │    │
│  │  • LibraryService    │          │  • UI 컴포넌트              │    │
│  │  • DbService         │          │  • Zustand 스토어           │    │
│  │  • FfmpegService     │          │  • TanStack Query 캐시       │    │
│  │  • ThumbnailService  │          │  • 비디오 플레이어 (HTML5)  │    │
│  │  • SubtitleService   │          │                             │    │
│  │  • FsWatcher         │          │                             │    │
│  └─────────┬────────────┘          └──────────────┬──────────────┘    │
│            │                                      │                   │
│            │           Preload (contextBridge)    │                   │
│            └──────────────────────────────────────┘                   │
└───────────────────────────────────────────────────────────────────────┘
        │                                                  │
        ▼                                                  ▼
   .db files / FFmpeg binary / OS file system        UI rendering
```

### 레이어

```
src/
 ├── shared/         ← Main / Renderer가 공유하는 타입, Zod 스키마, IPC 채널 상수
 ├── main/
 │   ├── ipc/        ← IPC 라우터 (채널 → 핸들러)
 │   ├── services/   ← 비즈니스 로직 (DI 가능한 클래스)
 │   ├── db/         ← better-sqlite3 래퍼, 마이그레이터, 리포지토리
 │   ├── ffmpeg/     ← FFmpeg/ffprobe 호출 추상화, 작업 큐
 │   └── infra/      ← 로깅, 설정, 파일 시스템 유틸
 ├── preload/
 │   └── api.ts      ← contextBridge로 노출하는 화이트리스트 API
 └── renderer/
     ├── pages/
     ├── components/
     ├── hooks/
     ├── store/
     └── api/        ← window.api 래핑 + TanStack Query 훅
```

### 데이터 플로우 (예: 동영상 가져오기)

```
사용자 "폴더에서 가져오기" 클릭
    │
    ▼
Renderer: useImportFolder.mutate(path)
    │ window.api.invoke('library:importFolder', { path })
    ▼
Preload → Main IPC 라우터
    │
    ▼
LibraryService.importFolder(path)
    ├── FsScanner.walk(path)            // mp4/mkv/... 추출
    ├── for each file:
    │     ├── HashService.sha256(file)  // 중복 검출 키
    │     ├── FfprobeService.probe()    // 길이, 해상도, 코덱
    │     ├── DbService.tx(insert)      // videos 테이블 저장
    │     └── ThumbnailQueue.enqueue()  // 비동기 썸네일 생성
    │
    ▼
이벤트 발행: ipcMain.send('library:imported', {added, skipped})
    │
    ▼
Renderer 측 EventBus가 구독 → TanStack Query invalidate
    │
    ▼
UI 자동 갱신
```

---

## 주요 기능

### 1. 동영상 재생

- HTML5 `<video>` + Plyr UI 기반 (Chromium 내장 디코더 활용)
- 하드웨어 가속(HW Acceleration) 자동 사용
- 배속 0.25x ~ 4.0x, 프레임 단위 스텝 (`,` / `.`), 구간 반복 (A-B Loop)
- 마지막 재생 위치 자동 저장 → 90% 이상 재생 시 "끝까지 봄"으로 카운트
- 끊김 없는 재생 위해 `MediaSource Extensions`는 사용하지 않고 `file://` 직접 참조

### 2. 카테고리 단위 라이브러리 관리

- 카테고리 = 단일 `.db` 파일 (SQLite)
- 다중 라이브러리 동시 마운트, 통합 가상 뷰 제공
- `.db` 헤더에 스키마 버전 기록 → 자동 마이그레이션
- 라이브러리 잠금: 동일 `.db`를 두 인스턴스에서 동시에 열면 read-only 모드로 자동 전환

### 3. 썸네일

- 등록 시 N장 자동 생성 (기본 5장: 10%, 30%, 50%, 70%, 90% 시점)
- 사용자가 임의 시점을 대표 썸네일로 지정 가능
- 썸네일은 `cache/<hash>/<index>.jpg`에 파일로 저장 (DB BLOB 회피, 빠른 로드)
- 그리드 뷰 호버 시 썸네일 시퀀스 애니메이션 (마우스 위치 비례 시점 표시)

### 4. 하이라이트 (타임코드 북마크)

- 단일 시점 또는 구간(`startMs ~ endMs`) 하이라이트
- 제목, 메모, 색상 태그
- 하이라이트 클릭 → 해당 구간으로 점프 + 자동 일시정지 옵션
- 구간 하이라이트는 A-B Loop와 연동

### 5. 자막 지원

- 외부 자막 우선순위: `<영상명>.<lang>.srt` > `<영상명>.srt`
- ASS/SSA: JASSUB(WebAssembly)로 스타일 보존 렌더링
- SMI: 자체 파서 → VTT 변환 후 렌더링
- 인코딩 자동 감지: `chardet` + 한국어 휴리스틱(EUC-KR/CP949 우선순위)
- 싱크 미세 조정: `±N ms`, 영상별 영구 저장

### 6~9. 별점 / 재생 횟수 / 디렉토리 / 한줄평

- 별점: 1~5 정수, 미설정(`null`) 구분 가능
- 재생 이력: 한 번의 시청 = `play_history` 한 행 (시작/종료 시각, 도달 비율 기록)
- 누적 재생 횟수는 트리거로 자동 갱신 (집계 캐시)
- 다중 루트 디렉토리, 누락 파일 표시 + 재연결 마법사 (해시 매칭)
- 한줄평: FTS5 가상 테이블로 전문 검색

---

## 지원 환경

| 항목              | 요구 사양                | 권장                               |
| ----------------- | ------------------------ | ---------------------------------- |
| OS                | Windows 10 21H2 (64-bit) | Windows 11 22H2+                   |
| CPU               | 2코어 / Intel 4세대 동급 | 4코어 / Intel 8세대 이상           |
| RAM               | 4GB                      | 8GB+                               |
| GPU               | DirectX 11 호환          | NVIDIA NVDEC / Intel QSV / AMD VCN |
| 디스크            | 200MB (앱) + 캐시        | SSD 권장, 캐시 5GB+                |
| Node.js (개발 시) | 18.x LTS                 | 20.x LTS                           |

> macOS / Linux는 현재 지원 대상이 아닙니다 (FFmpeg 정적 바이너리와 빌드 파이프라인만 추가하면 동작 가능).

---

## 지원 포맷

### 동영상 컨테이너

`MP4`, `MKV`, `AVI`, `MOV`, `WMV`, `FLV`, `WebM`, `TS`, `M2TS`, `MPG/MPEG`, `3GP`, `OGV`

### 비디오 코덱

H.264 (AVC), H.265 (HEVC), VP8, VP9, AV1, MPEG-2, MPEG-4 ASP, WMV9, ProRes

> Chromium이 직접 디코딩하지 못하는 코덱(예: HEVC 일부 빌드)은 FFmpeg로 실시간 트랜스먹스/트랜스코딩하여 재생합니다.

### 오디오 코덱

AAC, MP3, AC3, E-AC3, DTS, FLAC, Opus, Vorbis, PCM

### 자막 포맷

`.srt`, `.ass`, `.ssa`, `.sub`+`.idx`, `.smi`, `.vtt`, MKV/MP4 내장 트랙

---

## 데이터 구조 및 스키마

### 카테고리 `.db` 파일 (SQLite, WAL 모드)

```sql
-- schema_version: 단일 행, 마이그레이션 키
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY
);

-- 동영상 메타데이터
CREATE TABLE videos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path     TEXT    NOT NULL,                 -- 절대경로
    file_hash     TEXT    NOT NULL UNIQUE,          -- SHA-256 (앞 64MB만 해시)
    file_size     INTEGER NOT NULL,
    title         TEXT    NOT NULL,                 -- 기본값: 파일명 (확장자 제외)
    duration_ms   INTEGER NOT NULL,
    width         INTEGER,
    height        INTEGER,
    video_codec   TEXT,
    audio_codec   TEXT,
    container     TEXT,
    bitrate       INTEGER,
    fps           REAL,
    rating        INTEGER CHECK (rating BETWEEN 1 AND 5),
    review        TEXT,                             -- 한줄평
    play_count    INTEGER NOT NULL DEFAULT 0,       -- 트리거로 자동 갱신
    last_played_at INTEGER,                         -- Unix epoch ms
    last_position_ms INTEGER NOT NULL DEFAULT 0,    -- 이어보기
    added_at      INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    is_missing    INTEGER NOT NULL DEFAULT 0        -- 0/1
);
CREATE INDEX idx_videos_added_at  ON videos(added_at DESC);
CREATE INDEX idx_videos_rating    ON videos(rating);
CREATE INDEX idx_videos_last_played ON videos(last_played_at DESC);

-- 썸네일 (메타만 DB, 실제 파일은 cache/ 디렉토리)
CREATE TABLE thumbnails (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    position_ms   INTEGER NOT NULL,
    file_path     TEXT    NOT NULL,                 -- cache 상대경로
    is_primary    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_thumb_video ON thumbnails(video_id);

-- 하이라이트
CREATE TABLE highlights (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    start_ms      INTEGER NOT NULL,
    end_ms        INTEGER,                          -- NULL = 단일 시점
    title         TEXT,
    note          TEXT,
    color         TEXT,                             -- '#RRGGBB'
    created_at    INTEGER NOT NULL
);
CREATE INDEX idx_highlights_video ON highlights(video_id, start_ms);

-- 자막
CREATE TABLE subtitles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    source        TEXT    NOT NULL CHECK (source IN ('external','embedded')),
    file_path     TEXT,                             -- external일 때
    track_index   INTEGER,                          -- embedded일 때
    language      TEXT,
    encoding      TEXT,                             -- external일 때 (감지 결과)
    sync_offset_ms INTEGER NOT NULL DEFAULT 0,
    is_default    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_subtitles_video ON subtitles(video_id);

-- 재생 이력
CREATE TABLE play_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER NOT NULL,
    watched_ratio REAL    NOT NULL                  -- 0.0 ~ 1.0
);
CREATE INDEX idx_history_video ON play_history(video_id, started_at DESC);

-- 트리거: play_history INSERT 시 videos.play_count, last_played_at 갱신
CREATE TRIGGER trg_play_history_insert AFTER INSERT ON play_history
BEGIN
    UPDATE videos
    SET play_count = play_count + 1,
        last_played_at = NEW.ended_at,
        updated_at = NEW.ended_at
    WHERE id = NEW.video_id;
END;

-- 한줄평/제목 전문 검색 (FTS5)
CREATE VIRTUAL TABLE videos_fts USING fts5(
    title, review, content='videos', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

-- 카테고리 단위 설정 (key-value)
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL                              -- JSON 직렬화
);
```

### 글로벌 설정 위치

```
%APPDATA%\DarkVideoManager\
 ├── config.json           # 테마, 단축키, 플레이어 설정
 ├── libraries.json        # 등록된 .db 경로 목록 + 표시 이름
 ├── cache\                # 썸네일 캐시 (영상 hash 기준 디렉토리)
 │   └── <sha256>\
 │       ├── 0.jpg
 │       └── 1.jpg
 └── logs\
     ├── main-2026-04-25.log
     └── renderer-2026-04-25.log
```

### 마이그레이션 전략

- `migrations/` 폴더에 `001_init.sql`, `002_add_color.sql` 같이 순차 번호로 관리
- 앱 시작 시 `schema_version` 읽고 누락된 마이그레이션을 트랜잭션 내에서 순차 적용
- `DOWN` 마이그레이션은 제공하지 않음 (forward-only). 대신 자동 백업: `<lib>.db.bak.<timestamp>`

---

## IPC 인터페이스

모든 IPC 채널은 `src/shared/ipc.ts`에 상수와 Zod 스키마로 선언되며, Main / Renderer 양쪽이 동일한 타입을 공유합니다.

### 채널 네이밍

```
<domain>:<verb>      → invoke/handle (요청-응답)
<domain>:<event>     → send/on        (이벤트 푸시)
```

### 주요 채널

```typescript
// src/shared/ipc.ts
import { z } from 'zod'

export const IPC = {
  Library: {
    List: 'library:list', // () => Library[]
    Open: 'library:open', // (path) => Library
    Create: 'library:create', // (path, name) => Library
    Close: 'library:close', // (id) => void
    ImportFolder: 'library:importFolder', // (libId, path) => ImportResult
    Imported: 'library:imported', // event: ImportResult
  },
  Videos: {
    Search: 'videos:search', // (query) => VideoListPage
    Get: 'videos:get', // (id)    => VideoDetail
    UpdateMeta: 'videos:updateMeta', // (id, patch)
    Delete: 'videos:delete', // (id, deleteFile?: boolean)
  },
  Highlights: {
    List: 'highlights:list',
    Create: 'highlights:create',
    Update: 'highlights:update',
    Delete: 'highlights:delete',
  },
  Playback: {
    Start: 'playback:start', // (id) => sessionId
    Heartbeat: 'playback:heartbeat', // (sessionId, positionMs)
    End: 'playback:end', // (sessionId, watchedRatio)
  },
  Subtitles: {
    List: 'subtitles:list',
    Attach: 'subtitles:attach', // 외부 자막 추가
    SetSync: 'subtitles:setSync',
    DetectEnc: 'subtitles:detectEncoding',
  },
  Thumbnails: {
    Generate: 'thumbnails:generate', // (videoId, positions[])
    SetPrimary: 'thumbnails:setPrimary',
  },
} as const

export const ImportResultZ = z.object({
  added: z.number(),
  skipped: z.number(),
  failed: z.array(z.object({ path: z.string(), reason: z.string() })),
})
export type ImportResult = z.infer<typeof ImportResultZ>
```

### Preload (화이트리스트 노출)

```typescript
// src/preload/api.ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'

const api = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (!isAllowedChannel(channel)) throw new Error(`Blocked: ${channel}`)
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: string, listener: (...args: unknown[]) => void) {
    if (!isAllowedChannel(channel)) throw new Error(`Blocked: ${channel}`)
    const wrapped = (_: unknown, ...args: unknown[]) => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.off(channel, wrapped)
  },
}

contextBridge.exposeInMainWorld('api', api)
```

### Renderer 측 사용 예

```typescript
// src/renderer/api/videos.ts
export function useVideos(query: VideoQuery) {
  return useQuery({
    queryKey: ['videos', query],
    queryFn: () => window.api.invoke<VideoListPage>(IPC.Videos.Search, query),
    staleTime: 30_000,
  })
}
```

---

## FFmpeg 파이프라인

### 바이너리 관리

- 개발 시: `ffmpeg-static`이 OS별 바이너리를 자동 제공
- 빌드 시: `electron-builder`의 `extraResources`로 `resources/ffmpeg/`에 동봉
- 런타임 경로 결정: `app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', binName) : ffmpegStatic`

### 작업 큐

- FFmpeg는 무거운 외부 프로세스 → **글로벌 동시성 제한** (기본 2)
- `p-queue` 기반 우선순위 큐
- 진행률은 `progress` 이벤트로 IPC 푸시 → Renderer Toast 표시

```typescript
// src/main/ffmpeg/thumbnail.ts
export async function generateThumbnail(
  videoPath: string,
  positionMs: number,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cmd = ffmpeg(videoPath)
      .seekInput(positionMs / 1000) // 입력 측 seek (빠름)
      .frames(1)
      .outputOptions(['-q:v 3', '-vf scale=480:-2'])
      .save(outPath)
      .on('end', () => resolve())
      .on('error', reject)
    signal?.addEventListener('abort', () => cmd.kill('SIGTERM'))
  })
}
```

### ffprobe 메타데이터 추출

- 단일 호출로 stream 정보 + format 정보 동시 수집
- 결과는 Zod로 검증 후 도메인 타입으로 변환

---

## 보안 모델

Electron 보안 권장 사항을 모두 적용합니다.

| 설정                          | 값                                                                       | 이유                                 |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `contextIsolation`            | `true`                                                                   | Renderer와 Preload 컨텍스트 분리     |
| `nodeIntegration`             | `false`                                                                  | Renderer에서 Node API 직접 사용 불가 |
| `sandbox`                     | `true`                                                                   | OS 샌드박스 활성화                   |
| `webSecurity`                 | `true`                                                                   | 동일 출처 정책 유지                  |
| `allowRunningInsecureContent` | `false`                                                                  | HTTP 컨텐츠 차단                     |
| CSP                           | `default-src 'self'; media-src 'self' file:; img-src 'self' file: data:` | 외부 리소스 로딩 차단                |
| Preload                       | 화이트리스트 채널만 노출                                                 | 임의 IPC 호출 차단                   |
| 외부 링크                     | `shell.openExternal` 명시 호출만 허용, 그 외 `window.open` 거부          |

**파일 시스템 접근**: Renderer는 `file://` URL만 사용 가능하며, 직접적인 `fs` 접근은 불가. 모든 파일 읽기/쓰기는 IPC를 통해 Main에서 수행하고, 경로는 Main에서 화이트리스트(등록된 라이브러리 루트 하위)인지 검증합니다.

---

## 성능 최적화 전략

### DB

- `journal_mode = WAL`, `synchronous = NORMAL` (성능/안정성 균형)
- `cache_size = -64000` (64MB), `mmap_size = 268435456` (256MB)
- 핫 쿼리 prepared statement 캐시
- 1000건 이상 INSERT는 단일 트랜잭션 + `BEGIN IMMEDIATE`

### 썸네일

- DB BLOB 대신 파일 시스템 사용 → 그리드 렌더링 시 `<img src="file://...">` 직접 로드
- WebP 옵션 (저장 용량 절감), 기본은 JPEG q=3
- LRU 캐시로 디코드된 `ImageBitmap` 메모리 캐싱 (그리드 스크롤 성능)

### Renderer

- 그리드는 `@tanstack/react-virtual`로 가상화 (10만 건도 60fps)
- TanStack Query `staleTime` 설정으로 IPC 호출 중복 제거
- 무거운 변환(자막 ASS → Canvas)은 Web Worker로 격리
- React 18 `useTransition`으로 검색 입력 시 UI 잠김 방지

### 파일 워처

- `chokidar` `awaitWriteFinish` 활성화 (다운로드 중 파일 무시)
- 디바운스 500ms, 동일 디렉토리 변경은 배치 처리

### 해시 계산

- 전체 파일 해시는 비용이 큼 → **앞 64MB + 뒤 64MB + 파일 크기**로 단축 해시 사용
- 충돌 의심 시 풀 해시로 fallback

---

## 개발 환경 설정 및 빌드

### 사전 요구사항

| 도구                      | 버전                                                   |
| ------------------------- | ------------------------------------------------------ |
| Node.js                   | 18.x LTS 이상 (20.x LTS 권장)                          |
| npm                       | 9.x 이상                                               |
| Git                       | 최신                                                   |
| Visual Studio Build Tools | C++ 워크로드 (better-sqlite3 네이티브 빌드)            |
| Python                    | 3.x (node-gyp 의존, Build Tools와 함께 자동 설치 가능) |

`better-sqlite3`는 **Electron의 ABI에 맞춰 재빌드**가 필요합니다. `electron-builder install-app-deps` 또는 `electron-rebuild`로 처리됩니다 (postinstall 스크립트에 자동화).

### 1. 저장소 클론 및 의존성 설치

```bash
git clone https://github.com/your-username/DarkVideoManager.git
cd DarkVideoManager
npm install
# better-sqlite3 Electron ABI 매칭 (postinstall이 자동 실행하지 않을 경우)
npm run rebuild
```

### 2. 개발 모드 실행

#### 2-1. Electron 앱 (전체 기능)

```bash
npm run dev
```

내부 동작:

- `electron-vite dev` → Main/Preload는 esbuild, Renderer는 Vite HMR
- Main 코드 수정 시 자동 재시작
- Renderer 코드 수정 시 HMR

#### 2-2. 브라우저에서 UI만 (빠른 UI 개발용)

```bash
npm run dev:web
```

`http://localhost:5173`에서 접근. `VITE_MOCK_IPC=true`로 `window.api`가 mock 구현으로 대체되어 IPC 없이 컴포넌트 단독 개발 가능.

### 3. 프로덕션 빌드

```bash
npm run build         # 타입 검사 + 번들 (out/)
npm run build:win     # NSIS 인스톨러 + 포터블 (release/)
```

`electron-builder.yml` 핵심 설정:

```yaml
appId: com.darkvm.app
productName: DarkVideoManager
directories:
  output: release
files:
  - out/**/*
  - package.json
extraResources:
  - from: resources/ffmpeg
    to: ffmpeg
asarUnpack:
  - '**/better-sqlite3/build/**' # 네이티브 모듈은 unpack
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
  artifactName: ${productName}-${version}-${arch}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  shortcutName: DarkVideoManager
publish:
  provider: github
  owner: your-username
  repo: DarkVideoManager
```

### 4. 주요 npm 스크립트

| 명령어               | 설명                                        |
| -------------------- | ------------------------------------------- |
| `npm run dev`        | Electron 개발 모드                          |
| `npm run dev:web`    | 브라우저 단독 UI                            |
| `npm run build`      | 프로덕션 번들                               |
| `npm run build:win`  | Windows 패키징                              |
| `npm run rebuild`    | 네이티브 모듈 재빌드                        |
| `npm run lint`       | ESLint                                      |
| `npm run typecheck`  | `tsc --noEmit`                              |
| `npm test`           | Vitest 단위 테스트                          |
| `npm run test:e2e`   | Playwright E2E                              |
| `npm run db:migrate` | 빈 .db 파일에 마이그레이션 적용 (개발 도구) |

### 5. 환경 변수

`.env` (루트, gitignore):

```env
# 브라우저 단독 모드에서 IPC mock 활성화
VITE_MOCK_IPC=true

# 개발 시 로그 레벨 (trace | debug | info | warn | error)
LOG_LEVEL=debug

# 썸네일 캐시 디렉토리 오버라이드
DVM_CACHE_DIR=

# FFmpeg 바이너리 경로 오버라이드 (개발 디버깅용)
FFMPEG_PATH=
```

---

## 테스트 전략

### 단위 테스트 (Vitest)

- `src/main/services/**` — 서비스 로직 (DB는 인메모리 SQLite로 격리)
- `src/shared/**` — Zod 스키마, 순수 함수
- `src/renderer/hooks/**` — `@testing-library/react-hooks`

```bash
npm test                  # watch
npm test -- --run         # 단발 실행
npm test -- --coverage    # 커버리지 (목표 라인 80%+)
```

### 컴포넌트 테스트

- React Testing Library + Vitest
- `window.api`는 vi.mock으로 모킹

### E2E (Playwright + Electron)

- 빌드된 앱을 실제 실행 (`_electron.launch`)
- 시나리오:
  1. 빈 라이브러리 → `.db` 생성 → 폴더 가져오기 → 그리드 표시 검증
  2. 영상 클릭 → 재생 시작 → 5초 후 일시정지 → 이어보기 위치 저장 검증
  3. 별점 변경 → 재시작 후에도 유지

```bash
npm run test:e2e
```

### 픽스처

- `tests/fixtures/sample-videos/` — 5초 길이 더미 mp4 (FFmpeg로 생성, gitignore)
- `tests/fixtures/sample-subs/` — SRT/ASS/SMI 샘플

---

## CI / 릴리스

### GitHub Actions

`.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test -- --run
```

`.github/workflows/release.yml` (태그 푸시 시):

```yaml
name: Release
on:
  push:
    tags: ['v*.*.*']
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build:win
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          files: release/*.exe
```

### 릴리스 절차

1. `npm version <patch|minor|major>` → `package.json` 버전 갱신 + git tag 자동 생성
2. `git push --follow-tags`
3. CI가 빌드 → GitHub Release에 인스톨러 업로드
4. `electron-updater`가 사용자 앱에 업데이트 알림

---

## 사용 방법

### 처음 시작하기

1. 앱 실행 → 빈 라이브러리 화면
2. **"새 카테고리 만들기"** → `.db` 파일 저장 위치 선택 (예: `D:\library\영화.db`)
3. **"폴더에서 가져오기"** → 동영상 폴더 지정 → 백그라운드에서 자동 메타데이터/썸네일 추출
4. 그리드 뷰에서 영상 클릭 → 재생

### 카테고리 전환

좌측 사이드바에서 등록된 `.db` 카테고리 클릭. `Ctrl + Click`으로 다중 선택 시 통합 가상 뷰.

### 하이라이트

재생 중 `H` 키 → 현재 시점에 하이라이트 추가. 우측 패널에서 제목/메모 편집. 구간 하이라이트는 `Shift + H`로 시작 / 다시 `Shift + H`로 종료.

### 별점·한줄평

영상 상세 패널에서 즉시 편집, 자동 저장. 한줄평은 FTS5 전문 검색 가능.

### 검색과 필터

- 키워드 검색: 제목 + 한줄평 + 하이라이트 메모 통합
- 필터 칩: 별점 / 미시청 / 코덱 / 해상도 / 길이 범위 / 추가일 범위
- 정렬: 최근 추가 / 최근 재생 / 별점 / 재생 횟수 / 길이 / 파일 크기

---

## 디렉토리 구조

```
DarkVideoManager/
├── README.md
├── package.json
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── tsconfig.node.json
├── .env.example
├── .eslintrc.cjs
├── .prettierrc
├── migrations/
│   ├── 001_init.sql
│   └── 002_add_color.sql
├── resources/
│   ├── icon.ico
│   └── ffmpeg/                 # 동봉용 FFmpeg (빌드 시 복사)
├── src/
│   ├── shared/
│   │   ├── ipc.ts              # IPC 채널 + Zod 스키마
│   │   └── types.ts
│   ├── main/
│   │   ├── index.ts            # Electron 진입점, BrowserWindow
│   │   ├── ipc/
│   │   │   ├── index.ts        # 핸들러 등록
│   │   │   ├── library.ts
│   │   │   ├── videos.ts
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── LibraryService.ts
│   │   │   ├── VideoService.ts
│   │   │   ├── ThumbnailService.ts
│   │   │   ├── SubtitleService.ts
│   │   │   └── PlaybackService.ts
│   │   ├── db/
│   │   │   ├── connection.ts
│   │   │   ├── migrator.ts
│   │   │   └── repositories/
│   │   ├── ffmpeg/
│   │   │   ├── ffmpegPath.ts
│   │   │   ├── ffprobe.ts
│   │   │   ├── thumbnail.ts
│   │   │   └── queue.ts
│   │   └── infra/
│   │       ├── logger.ts
│   │       ├── config.ts
│   │       └── fs.ts
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── main.tsx
│       ├── App.tsx
│       ├── pages/
│       ├── components/
│       ├── hooks/
│       ├── store/
│       ├── api/
│       └── styles/
├── tests/
│   ├── unit/
│   ├── e2e/
│   └── fixtures/
├── .github/
│   └── workflows/
└── release/                    # 빌드 산출물 (gitignore)
```

---

## 화면 구성 및 단축키

### 레이아웃

| 영역               | 설명                                               |
| ------------------ | -------------------------------------------------- |
| 좌측 사이드바      | 등록된 카테고리(`.db`), 빠른 필터(별점, 미시청 등) |
| 상단 검색 바       | 통합 검색, 정렬·필터 옵션                          |
| 중앙 그리드/리스트 | 가상화된 썸네일 목록                               |
| 우측 상세 패널     | 별점, 한줄평, 하이라이트, 메타데이터               |
| 하단 플레이어 도크 | 재생 컨트롤, 자막·배속, 하이라이트 타임라인        |

### 단축키 기본값

| 키              | 동작                              |
| --------------- | --------------------------------- |
| `Space`         | 재생 / 일시정지                   |
| `←` / `→`       | 5초 뒤/앞                         |
| `Shift + ← / →` | 30초 뒤/앞                        |
| `,` / `.`       | 프레임 단위 뒤/앞 (정지 상태에서) |
| `↑` / `↓`       | 음량 조절                         |
| `M`             | 음소거                            |
| `F`             | 전체화면                          |
| `H`             | 단일 시점 하이라이트 추가         |
| `Shift + H`     | 구간 하이라이트 시작/종료         |
| `[` / `]`       | 자막 싱크 ±100ms                  |
| `1`~`5`         | 별점 부여                         |
| `Ctrl + F`      | 검색 포커스                       |
| `Ctrl + ,`      | 설정                              |

> 모든 단축키는 설정에서 재정의 가능합니다.

---

## 개발 로드맵

### v0.1 (MVP)

- 카테고리(`.db`) 생성·삭제, 마이그레이션 인프라
- 폴더 가져오기 + 메타데이터/썸네일 자동 추출
- 기본 재생, 외부 SRT 자막, 별점, 한줄평
- IPC 화이트리스트, 보안 기본 설정

### v0.2

- 하이라이트 (단일 시점 + 구간)
- ASS/SSA 자막 (JASSUB)
- 다중 자막 트랙 전환, 인코딩 자동 감지
- 재생 이력 + 통계 대시보드

### v0.3

- 다중 카테고리 통합 검색 (FTS5)
- 누락 파일 재연결 마법사 (해시 매칭)
- 파일 워처로 자동 추가/제거
- 자동 업데이트 (electron-updater)

### v1.0

- 테마 / 사용자 정의 단축키 / 다국어 (한/영)
- 설정 가져오기·내보내기
- 접근성 (키보드 전용 내비게이션, ARIA)
- 안정화 + E2E 커버리지 80%+

### Future

- macOS / Linux 빌드
- 모바일 동기화 (별점·한줄평·하이라이트만, CRDT 검토)
- AI 기반 장면 자동 태깅 / 썸네일 추천 (로컬 모델)
- 플러그인 시스템 (외부 자막 소스, 메타데이터 보강)

---

## 트러블슈팅

### `better-sqlite3` 설치 실패 (Windows)

- Visual Studio Build Tools(C++ 워크로드) 설치 확인
- `npm config set msvs_version 2022`
- `npm rebuild better-sqlite3`

### Electron 실행 시 "Cannot find module" 오류

- `npm run rebuild` 실행 (Node ABI ↔ Electron ABI 불일치)

### HEVC 영상이 재생되지 않음

- 일부 Chromium 빌드는 HEVC 라이선스 미포함 → FFmpeg 트랜스먹스 fallback 사용
- 또는 Microsoft Store에서 "HEVC 비디오 확장" 설치

### 자막이 깨져 보임

- 자막 인코딩 자동 감지가 실패한 경우, 영상 상세 패널에서 인코딩 수동 지정
- `chardet`이 짧은 텍스트에서는 정확도가 떨어질 수 있음

### 동일 파일이 중복 추가됨

- 해시는 파일 앞 64MB + 뒤 64MB + 크기 기반 → 매우 큰 파일에서 같은 헤더를 공유하면 false positive 가능
- 설정에서 "Full hash 모드" 활성화 시 전체 SHA-256 사용 (속도 저하)

---

## 라이선스

라이선스는 추후 결정될 예정입니다. 결정 전까지는 개인적인 사용 목적에 한해 자유롭게 활용하실 수 있으나, 재배포는 자제해 주세요.

> FFmpeg는 LGPL/GPL 라이선스를 따릅니다. 동봉 빌드 종류에 따라 본 프로젝트의 라이선스 호환성을 확인해야 합니다.

---

## 문의

- 이슈 트래커: 프로젝트 저장소의 Issues 탭
- 작성자: DarkVideoManager Contributors

마지막 업데이트: 2026-04-25
