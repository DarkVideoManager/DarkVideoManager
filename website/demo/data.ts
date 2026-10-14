import type { Highlight, Library, Subtitle, Thumbnail, Video } from '../../src/shared/types'

export const DEMO_LIBRARY_ID = 'baseball-demo'
export const DEMO_STORAGE_KEY = 'dark-video-manager.website-demo.v1'
export const DEMO_SEED_PLAY_COUNTS: Readonly<Record<string, number>> = {
  'baseball-1': 57,
  'baseball-2': 25,
}
export const DEMO_NOTICE =
  '공개 야구 영상 체험입니다. 샘플 자막은 AI 결과나 음성을 옮긴 자막이 아닌 수작업 장면 설명입니다.'
const SHORT_VIDEO_NOTICE =
  'CC0 · D. Benjamin Miller 촬영 · 원본 무음. 샘플 자막은 AI 결과가 아닌 수작업 장면 설명입니다.'
export const DEMO_STATS_NOTICE =
  '기본 시청 기록과 별점은 체험용 예시입니다. 직접 재생한 기록은 이 브라우저에 추가됩니다.'

export interface DemoHistoryEntry {
  id: string
  videoId: string
  startedAt: string
  watchedSec: number
}

export interface DemoMedia {
  id: string
  fileName: string
  poster: string
  title: string
  durationSec: number
  width: number
  height: number
  sizeBytes: number
  codec: string
  posterAtSeconds: number
  tags: string
  rightsNotice?: string
  scenes: Array<{ start: number; end: number; text: string }>
}

const worldSeriesEnding: Record<DemoCaptionLanguage, string> = {
  en: 'The excerpt ends with views of the field and cheering spectators.',
  ko: '경기장과 환호하는 관중을 비추며 이 발췌 영상이 끝납니다.',
  ja: 'グラウンドと声援を送る観客を映しながら、この抜粋が終わります。',
  zh: '这段节选以球场和欢呼观众的画面结束。',
}

const worldSeriesScenes: Array<{
  start: number
  end: number
  text: Record<DemoCaptionLanguage, string>
}> = [
  {
    start: 0,
    end: 8,
    text: {
      en: 'The newsreel opens with a World Series title card.',
      ko: '월드시리즈를 소개하는 뉴스릴 제목 화면입니다.',
      ja: 'ワールドシリーズを紹介するニュース映画のタイトルです。',
      zh: '新闻影片以世界大赛标题画面开场。',
    },
  },
  {
    start: 8,
    end: 18,
    text: {
      en: 'Spectators gather outside the ballpark.',
      ko: '관중들이 야구장 밖으로 모여듭니다.',
      ja: '観客が球場の外に集まります。',
      zh: '观众聚集在棒球场外。',
    },
  },
  {
    start: 18,
    end: 28,
    text: {
      en: 'Men in Yankees and Dodgers uniforms pose together.',
      ko: '양키스와 다저스 유니폼을 입은 인물들이 함께 서 있습니다.',
      ja: 'ヤンキースとドジャースのユニフォーム姿の人物が並びます。',
      zh: '身穿洋基队和道奇队制服的人物站在一起。',
    },
  },
  {
    start: 28,
    end: 38,
    text: {
      en: 'The crowded stands surround the field.',
      ko: '경기장을 둘러싼 관중석이 사람들로 가득합니다.',
      ja: 'グラウンドを囲む観客席が人で埋まっています。',
      zh: '球场周围的看台上坐满了观众。',
    },
  },
  {
    start: 38,
    end: 48,
    text: {
      en: 'A wide view shows the outfield and the foul line.',
      ko: '넓게 잡은 화면에 외야와 파울 라인이 보입니다.',
      ja: '広い画面に外野とファウルラインが見えます。',
      zh: '全景画面展现外野和边线。',
    },
  },
  {
    start: 48,
    end: 58,
    text: {
      en: 'Players move along the base path beside the crowd.',
      ko: '관중석 옆 베이스 경로를 따라 선수들이 움직입니다.',
      ja: '観客席のそばの走路を選手が移動します。',
      zh: '球员沿着看台旁的垒道移动。',
    },
  },
  {
    start: 58,
    end: 70,
    text: {
      en: 'A fielder runs across the grass with his glove.',
      ko: '글러브를 낀 수비수가 잔디 위를 달립니다.',
      ja: 'グラブを持つ野手が芝生を走ります。',
      zh: '戴着手套的守场员跑过草地。',
    },
  },
  {
    start: 70,
    end: 88,
    text: {
      en: 'The film follows fielders and runners around the diamond.',
      ko: '화면이 경기장 안의 수비수와 주자들을 따라갑니다.',
      ja: '映像がグラウンドの野手と走者を追います。',
      zh: '镜头跟随场上的守场员和跑者。',
    },
  },
  {
    start: 88,
    end: 108,
    text: {
      en: 'Fans in the stands rise, smile, and cheer.',
      ko: '관중석의 팬들이 일어나 웃으며 환호합니다.',
      ja: '観客席のファンが立ち上がり、笑顔で声援を送ります。',
      zh: '看台上的球迷起身，微笑并欢呼。',
    },
  },
  {
    start: 108,
    end: 130,
    text: {
      en: 'Overhead views show action near home plate and the base line.',
      ko: '위에서 내려다본 화면에 홈플레이트와 베이스 라인 주변 움직임이 보입니다.',
      ja: '上からの映像に本塁とベースライン付近の動きが映ります。',
      zh: '俯视画面展示本垒和垒线附近的比赛动作。',
    },
  },
  {
    start: 130,
    end: 150,
    text: {
      en: 'A runner rounds the bases as the camera follows.',
      ko: '카메라가 베이스를 도는 주자를 따라갑니다.',
      ja: 'カメラがベースを回る走者を追います。',
      zh: '镜头跟随绕垒奔跑的跑者。',
    },
  },
  {
    start: 150,
    end: 170,
    text: {
      en: 'Fielders and runners continue the play across the diamond.',
      ko: '수비수와 주자들이 경기장 곳곳에서 플레이를 이어갑니다.',
      ja: '野手と走者がグラウンドでプレーを続けます。',
      zh: '守场员和跑者在场上继续比赛。',
    },
  },
  {
    start: 170,
    end: 177,
    text: {
      en: 'Players converge near home plate in a wide overhead view.',
      ko: '넓게 내려다본 화면에서 선수들이 홈플레이트 근처로 모입니다.',
      ja: '広い俯瞰映像で選手が本塁付近に集まります。',
      zh: '全景俯视镜头中，球员聚集到本垒附近。',
    },
  },
  {
    start: 177,
    end: 180,
    text: worldSeriesEnding,
  },
]

// Keep the actual media inventory here so attribution/metadata can be revised
// without changing persistence or browser playback code.
export const demoMedia: readonly DemoMedia[] = [
  {
    id: 'baseball-1',
    fileName: 'tim-peterson-delivery.mp4',
    poster: 'tim-peterson-delivery.jpg',
    title: 'Tim Peterson · 투구 동작',
    durationSec: 7.007,
    width: 600,
    height: 450,
    sizeBytes: 363478,
    codec: 'h264',
    posterAtSeconds: 2,
    tags: '야구, 투구, CC0',
    scenes: [
      { start: 0, end: 2.5, text: '[수작업 장면 설명] 야구 투수의 동작을 살펴보세요.' },
      {
        start: 2.5,
        end: 5,
        text: '[수작업 장면 설명] 원하는 순간을 하이라이트로 저장할 수 있습니다.',
      },
      { start: 5, end: 7, text: '[수작업 장면 설명] 자막을 클릭하면 해당 시점으로 이동합니다.' },
    ],
  },
  {
    id: 'baseball-2',
    fileName: 'gant-windup.mp4',
    poster: 'gant-windup.jpg',
    title: 'John Gant · 와인드업',
    durationSec: 14.222542,
    width: 1280,
    height: 720,
    sizeBytes: 1451895,
    codec: 'h264',
    posterAtSeconds: 7,
    tags: '야구, 와인드업, CC0',
    scenes: [
      { start: 0, end: 4, text: '[수작업 장면 설명] 투구 동작을 관찰하는 짧은 야구 영상입니다.' },
      {
        start: 4,
        end: 9,
        text: '[수작업 장면 설명] 마음에 드는 화면을 대표 썸네일로 지정해 보세요.',
      },
      { start: 9, end: 14, text: '[수작업 장면 설명] 별점·메모·태그는 이 브라우저에 저장됩니다.' },
    ],
  },
  {
    id: 'baseball-3',
    fileName: 'tim-peterson-out.mp4',
    poster: 'tim-peterson-out.jpg',
    title: 'Tim Peterson · 짧은 장면',
    durationSec: 3.461792,
    width: 1280,
    height: 720,
    sizeBytes: 634922,
    codec: 'h264',
    posterAtSeconds: 1,
    tags: '야구, 자막 없음, CC0',
    scenes: [],
  },
  {
    id: 'baseball-4',
    fileName: 'world-series-1955.mp4',
    poster: 'world-series-1955.jpg',
    title: '1955 월드시리즈 · 3분 경기 기록',
    durationSec: 180.002979,
    width: 640,
    height: 360,
    sizeBytes: 8088782,
    codec: 'h264',
    posterAtSeconds: 60,
    tags: '야구, 월드시리즈, 경기 기록, 3분, 퍼블릭 도메인',
    rightsNotice:
      '퍼블릭 도메인 · Universal Newsreel / NARA · 원본 오디오 포함. 처음 3분을 연속 발췌했습니다. 자막은 AI·음성 인식 결과가 아닌 수작업 장면 설명입니다.',
    scenes: worldSeriesScenes.map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: `[수작업 장면 설명] ${cue.text.ko}`,
    })),
  },
]

// Freeze the seed once per module load so videos and history always agree.
const snapshotTime = new Date()
const firstDay = new Date(snapshotTime)
firstDay.setDate(firstDay.getDate() - 29)
firstDay.setHours(0, 0, 0, 0)
const INITIAL_DATE = firstDay.toISOString()
const exampleHistory: DemoHistoryEntry[] = []
const restDays = new Set([4, 9, 16, 23, 27])
for (let daysAgo = 29; daysAgo >= 0; daysAgo -= 1) {
  if (restDays.has(daysAgo)) continue
  const plays = 3 + ((daysAgo * 7) % 5)
  for (let play = 0; play < plays; play += 1) {
    // Keep the original three-video seed IDs stable when adding longer samples.
    const media = demoMedia[(daysAgo + play) % 3]
    const started = new Date(snapshotTime)
    if (daysAgo === 0) {
      // Never invent a future watch time, including shortly after midnight.
      started.setTime(snapshotTime.getTime() - (plays - play) * 11 * 60 * 1000)
    } else {
      started.setDate(started.getDate() - daysAgo)
      started.setHours(9 + ((daysAgo * 3 + play * 2) % 13), (7 + play * 11) % 60, 0, 0)
    }
    const fraction = [1, 0.8, 1, 0.65][(daysAgo + play) % 4]
    exampleHistory.push({
      id: `demo-history-${daysAgo}-${play}-${media.id}`,
      videoId: media.id,
      startedAt: started.toISOString(),
      watchedSec: Math.floor(media.durationSec * fraction * 1000) / 1000,
    })
  }
}
for (const [videoId, target] of Object.entries(DEMO_SEED_PLAY_COUNTS)) {
  const entries = exampleHistory.filter((entry) => entry.videoId === videoId)
  const excess = new Set(
    entries.slice(0, Math.max(0, entries.length - target)).map((entry) => entry.id),
  )
  for (let index = exampleHistory.length - 1; index >= 0; index -= 1)
    if (excess.has(exampleHistory[index].id)) exampleHistory.splice(index, 1)
  const media = demoMedia.find((item) => item.id === videoId)!
  for (let index = entries.length; index < target; index += 1) {
    const started = new Date(snapshotTime)
    started.setTime(snapshotTime.getTime() - (1 + (index % 29)) * 24 * 60 * 60 * 1000)
    exampleHistory.push({
      id: `demo-history-curated-${index}-${videoId}`,
      videoId,
      startedAt: started.toISOString(),
      watchedSec: Math.floor(media.durationSec * [1, 0.8, 0.65][index % 3] * 1000) / 1000,
    })
  }
}
for (const [index, daysAgo] of [28, 25, 22, 20, 17, 14, 11, 8, 6, 3, 1, 0].entries()) {
  const started = new Date(snapshotTime)
  if (daysAgo === 0) started.setTime(snapshotTime.getTime() - 45 * 60 * 1000)
  else {
    started.setDate(started.getDate() - daysAgo)
    started.setHours(12 + (index % 8), 20, 0, 0)
  }
  exampleHistory.push({
    id: `demo-history-long-${daysAgo}-baseball-4`,
    videoId: 'baseball-4',
    startedAt: started.toISOString(),
    watchedSec: [180, 132, 165, 96][index % 4],
  })
}
exampleHistory.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

export function makeDemoHistory(): DemoHistoryEntry[] {
  return exampleHistory.map((entry) => ({ ...entry }))
}

export const demoLibrary: Library = {
  id: DEMO_LIBRARY_ID,
  name: '야구 영상 · 브라우저 데모',
  dbPath: '브라우저 데모 저장소 (이 기기의 localStorage)',
  folderPath: '/demo-media',
  createdAt: INITIAL_DATE,
}

export function makeDemoVideos(): Video[] {
  const notes = [
    '예시 메모 · 3.5초의 릴리스와 5.5초의 마무리 자세를 비교해 보세요.',
    '예시 메모 · 5초의 준비 자세에서 10.5초의 투구까지 천천히 살펴보세요.',
    '예시 메모 · 1루 주변의 움직임을 기록하고 자막 없는 영상 필터를 체험해 보세요.',
    '예시 메모 · 1분의 수비 장면, 2분 20초의 주루, 2분 55초의 홈플레이트 장면을 찾아보세요.',
  ]
  return demoMedia.map((media, index) => {
    const history = exampleHistory.filter((entry) => entry.videoId === media.id)
    return {
      id: media.id,
      filePath: `/demo-media/${media.fileName}`,
      fileName: media.fileName,
      title: media.title,
      durationSec: media.durationSec,
      width: media.width,
      height: media.height,
      sizeBytes: media.sizeBytes,
      codec: media.codec,
      container: 'mp4',
      rating: [4.5, 2.5, 3.5, 4.5][index],
      memo: `${notes[index]}\n${media.rightsNotice ?? SHORT_VIDEO_NOTICE}`,
      tags: media.tags,
      createdAt:
        media.id === 'baseball-4'
          ? new Date(firstDay.getTime() + 1000).toISOString()
          : INITIAL_DATE,
      updatedAt: INITIAL_DATE,
      playCount: history.length,
      playTimeSec: history.reduce((total, entry) => total + entry.watchedSec, 0),
      lastPlayedAt: history.at(-1)?.startedAt,
      resumePosSec: 0,
      hasSubtitles: media.scenes.length > 0,
      primaryThumbnailPath: `/demo-media/${media.poster}`,
    }
  })
}

export function makeDemoThumbnails(): Thumbnail[] {
  return demoMedia.map((media) => ({
    id: `${media.id}-poster`,
    videoId: media.id,
    filePath: `/demo-media/${media.poster}`,
    timeSec: media.posterAtSeconds,
    isPrimary: true,
    createdAt: INITIAL_DATE,
  }))
}

export function makeDemoHighlights(): Highlight[] {
  return [
    {
      id: 'baseball-1-example',
      videoId: 'baseball-1',
      timeStart: 2,
      label: '예시 · 투구 전 준비 자세',
      color: 'yellow',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-2-example',
      videoId: 'baseball-2',
      timeStart: 5,
      label: '예시 · 와인드업 준비',
      color: 'blue',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-1-release-example',
      videoId: 'baseball-1',
      timeStart: 3.5,
      label: '예시 · 공을 놓는 순간',
      color: 'red',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-1-finish-example',
      videoId: 'baseball-1',
      timeStart: 5.5,
      label: '예시 · 투구 후 자세 정리',
      color: 'green',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-2-release-example',
      videoId: 'baseball-2',
      timeStart: 10.5,
      label: '예시 · 투구와 팔의 움직임',
      color: 'red',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-2-finish-example',
      videoId: 'baseball-2',
      timeStart: 12,
      label: '예시 · 마운드 위 마무리',
      color: 'purple',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-3-base-example',
      videoId: 'baseball-3',
      timeStart: 0.6,
      label: '예시 · 1루 주변 움직임',
      color: 'yellow',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-3-fielding-example',
      videoId: 'baseball-3',
      timeStart: 1.8,
      label: '예시 · 내야로 이동하는 수비수',
      color: 'blue',
      createdAt: INITIAL_DATE,
    },
    {
      id: 'baseball-3-runner-example',
      videoId: 'baseball-3',
      timeStart: 2.9,
      label: '예시 · 1루에 남은 주자',
      color: 'green',
      createdAt: INITIAL_DATE,
    },
    ...[
      [20, '두 팀 유니폼을 한 화면에서', 'blue'],
      [40, '경기장과 외야 전경', 'green'],
      [60, '잔디 위 수비 동작', 'yellow'],
      [100, '관중석의 환호', 'purple'],
      [140, '베이스를 도는 주자', 'red'],
      [175, '홈플레이트 주변 플레이', 'yellow'],
    ].map(([time, label, color]) => ({
      id: `baseball-4-${time}-example`,
      videoId: 'baseball-4',
      timeStart: Number(time),
      label: `예시 · ${label}`,
      color: color as Highlight['color'],
      createdAt: INITIAL_DATE,
    })),
  ]
}

export function demoSubtitles(videoId: string): Subtitle[] {
  const media = demoMedia.find((item) => item.id === videoId)
  return media?.scenes.length
    ? [
        {
          id: `${videoId}-manual-scenes`,
          videoId,
          filePath: `/demo-media/${videoId}.manual-scene-description.vtt`,
          lang: 'ko',
          encoding: 'UTF-8',
          type: 'vtt',
          isEmbedded: false,
        },
      ]
    : []
}

export function demoVtt(videoId: string): string | undefined {
  const media = demoMedia.find((item) => item.id === videoId)
  if (!media?.scenes.length) return undefined
  return renderVtt(media.scenes, media.durationSec)
}

function renderVtt(cues: DemoMedia['scenes'], durationSec: number): string {
  const stamp = (seconds: number): string => {
    const milliseconds = Math.floor(seconds * 1000)
    return `${String(Math.floor(milliseconds / 3600000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`
  }
  return `WEBVTT\n\nNOTE 수작업 체험용 장면 설명입니다. AI 생성 자막이나 실제 발화를 옮긴 자막이 아닙니다.\nManually written demo descriptions; not AI output or a transcription of speech.\n\n${cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(Math.min(cue.end, durationSec))}\n${cue.text}\n`).join('\n')}`
}

type DemoCaptionLanguage = 'en' | 'ko' | 'ja' | 'zh'
const captionPrefixes: Record<DemoCaptionLanguage, string> = {
  en: '[Manual demo · not AI or speech]',
  ko: '[수작업 체험 자막 · AI·음성 인식 아님]',
  ja: '[手書き体験字幕 · AI・音声認識ではありません]',
  zh: '[人工演示字幕 · 非AI或语音识别]',
}
const preparedScenes: Record<
  string,
  Array<{
    start: number
    end: number
    text: Record<DemoCaptionLanguage, string>
  }>
> = {
  'baseball-4': worldSeriesScenes,
  'baseball-1': [
    {
      start: 0,
      end: 2.8,
      text: {
        en: 'The pitcher gets set on the mound.',
        ko: '투수가 마운드 위에서 투구를 준비합니다.',
        ja: '投手がマウンドで投球の準備をします。',
        zh: '投手在投手丘上准备投球。',
      },
    },
    {
      start: 2.8,
      end: 4.6,
      text: {
        en: 'He strides forward and delivers the pitch.',
        ko: '앞으로 발을 내디디며 공을 던집니다.',
        ja: '前に踏み出してボールを投げます。',
        zh: '他向前迈步并投出球。',
      },
    },
    {
      start: 4.6,
      end: 7.007,
      text: {
        en: 'The pitcher straightens up after the throw.',
        ko: '투수가 공을 던진 뒤 자세를 바로잡습니다.',
        ja: '投げ終えた投手が姿勢を整えます。',
        zh: '投手投球后站直身体。',
      },
    },
  ],
  'baseball-2': [
    {
      start: 0,
      end: 8.8,
      text: {
        en: 'John Gant prepares for his windup on the mound.',
        ko: '존 갠트가 마운드에서 와인드업을 준비합니다.',
        ja: 'ジョン・ガントがマウンドでワインドアップを準備します。',
        zh: '约翰·甘特在投手丘上准备挥臂投球。',
      },
    },
    {
      start: 8.8,
      end: 11.3,
      text: {
        en: 'He steps forward and follows through with his throwing arm.',
        ko: '앞으로 발을 내디디고 팔을 뻗어 공을 던집니다.',
        ja: '前に踏み出し、腕を振り抜いて投球します。',
        zh: '他向前迈步，挥臂完成投球。',
      },
    },
    {
      start: 11.3,
      end: 14.222542,
      text: {
        en: 'He returns to an upright stance on the mound.',
        ko: '마운드 위에서 다시 똑바로 선 자세로 돌아옵니다.',
        ja: 'マウンドで再び体を起こして立ちます。',
        zh: '他在投手丘上重新站直。',
      },
    },
  ],
  'baseball-3': [
    {
      start: 0,
      end: 1.1,
      text: {
        en: 'A runner and fielders move around first base.',
        ko: '주자와 수비수들이 1루 주변에서 움직입니다.',
        ja: '走者と野手が一塁の周りで動いています。',
        zh: '跑者和守场员在一垒附近移动。',
      },
    },
    {
      start: 1.1,
      end: 2.3,
      text: {
        en: 'A fielder moves away from first base toward the infield.',
        ko: '수비수가 1루를 지나 내야 쪽으로 이동합니다.',
        ja: '野手が一塁を離れて内野の方へ移動します。',
        zh: '一名守场员离开一垒，向内野移动。',
      },
    },
    {
      start: 2.3,
      end: 3.461792,
      text: {
        en: 'The runner stays near first base as the fielders turn away.',
        ko: '수비수들이 돌아서는 동안 주자는 1루 근처에 남습니다.',
        ja: '野手が向きを変える間、走者は一塁の近くに残ります。',
        zh: '守场员转身离开时，跑者仍留在一垒附近。',
      },
    },
  ],
}

/** Prepared manual captions only: no speech recognition or translation service. */
export function demoGeneratedVtt(videoId: string, lang: string): string | undefined {
  const language = lang === 'auto' ? 'en' : lang
  const media = demoMedia.find((item) => item.id === videoId)
  if (!media || !Object.prototype.hasOwnProperty.call(captionPrefixes, language)) return undefined
  const selected = language as DemoCaptionLanguage
  const cues = preparedScenes[videoId]
  if (!cues) return undefined
  return renderVtt(
    cues.map((cue) => ({
      start: cue.start,
      end: cue.end,
      text: `${captionPrefixes[selected]} ${cue.text[selected]}`,
    })),
    media.durationSec,
  )
}

/** Correct only the exact previously shipped sample lines; do not rewrite saved user state. */
export function correctDemoCaptionText(videoId: string, content: string): string {
  if (videoId !== 'baseball-4') return content
  const oldEnding: Record<DemoCaptionLanguage, string> = {
    en: 'The excerpt ends on cheering spectators.',
    ko: '환호하는 관중을 비추며 이 발췌 영상이 끝납니다.',
    ja: '声援を送る観客の映像で、この抜粋が終わります。',
    zh: '这段节选在观众的欢呼画面中结束。',
  }
  const corrections = new Map<string, string>(
    (Object.keys(oldEnding) as DemoCaptionLanguage[]).map((lang) => [
      `${captionPrefixes[lang]} ${oldEnding[lang]}`,
      `${captionPrefixes[lang]} ${worldSeriesEnding[lang]}`,
    ]),
  )
  corrections.set(
    `[수작업 장면 설명] ${oldEnding.ko}`,
    `[수작업 장면 설명] ${worldSeriesEnding.ko}`,
  )
  return content.replace(/[^\r\n]+/g, (line) => corrections.get(line) ?? line)
}
