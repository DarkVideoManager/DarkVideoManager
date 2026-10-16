import { IPC } from '@shared/ipc'
import { registerIpcHandler } from './index'
import { ok, err } from '@shared/result'
import { getStats } from '../services/StatsService'
import { getDatabase } from '../db/connection'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'
import { VideoRepository } from '../db/repositories/VideoRepository'
import {
  convertSmiToVtt,
  convertSrtToVtt,
  syncSidecarSubtitlesForVideo,
  readFileSmart,
} from '../services/SubtitleService'
import { getThumbnailsDir } from '../infra/paths'
import { createLogger } from '../infra/logger'
import { isLibraryBusy } from '../services/LibraryWorkService'
import { join } from 'path'
import { readFileSync } from 'fs'

const log = createLogger('ipc:stats')

export function registerStatsHandlers(): void {
  registerIpcHandler(IPC.SUBTITLES.READ_TEXT, (_event, _libraryId, subtitlePath) =>
    ok(
      subtitlePath.toLowerCase().endsWith('.vtt')
        ? readFileSync(subtitlePath, 'utf-8')
        : readFileSmart(subtitlePath),
    ),
  )
  registerIpcHandler(IPC.STATS.GET, (_e, libraryId: string, days?: number) => {
    try {
      return ok(getStats(libraryId, days))
    } catch (e) {
      log.error({ err: e }, 'stats:get 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(IPC.SUBTITLES.GET_FOR_VIDEO, (_e, libraryId: string, videoId: string) => {
    try {
      const db = getDatabase(libraryId)
      if (!db) return err('라이브러리가 열려 있지 않습니다')
      let subtitles = new SubtitleRepository(db).findByVideoId(videoId)
      // Discovery mutates the index; an active job owns its snapshot until cleanup finishes.
      if (isLibraryBusy(libraryId)) return ok(subtitles)
      const video = new VideoRepository(db).findById(videoId)
      if (video && !video.removalMode) {
        try {
          subtitles = syncSidecarSubtitlesForVideo(db, video.id, video.filePath)
        } catch (e) {
          // An offline drive must not erase or hide a previously indexed track list.
          if (!subtitles.length) throw e
          log.error({ err: e }, '외부 자막 재확인 실패, 저장된 자막 목록 유지')
        }
      }
      return ok(subtitles)
    } catch (e) {
      log.error({ err: e }, 'subtitles:getForVideo 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(
    IPC.SUBTITLES.CONVERT_TO_VTT,
    (_e, libraryId: string, subtitlePath: string, type: 'smi' | 'srt') => {
      try {
        const outputDir = join(getThumbnailsDir(libraryId), '..', 'subtitles')
        const vttPath =
          type === 'smi'
            ? convertSmiToVtt(subtitlePath, outputDir)
            : convertSrtToVtt(subtitlePath, outputDir)
        return ok(vttPath)
      } catch (e) {
        log.error({ err: e }, 'subtitles:convertToVtt 오류')
        return err((e as Error).message)
      }
    },
  )
}
