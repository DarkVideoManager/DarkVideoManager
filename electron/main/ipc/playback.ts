import { IPC } from '@shared/ipc'
import { registerIpcHandler } from './index'
import { ok, err } from '@shared/result'
import { startPlayback, heartbeat, recordSeek, endPlayback } from '../services/PlaybackService'
import { createLogger } from '../infra/logger'
import {
  listPlaybackConversionJobs,
  pausePlaybackConversionJob,
  resumePlaybackConversionJob,
  removePlaybackConversionJob,
} from '../services/PlaybackConversionService'

const log = createLogger('ipc:playback')

export function registerPlaybackHandlers(): void {
  registerIpcHandler(IPC.PLAYBACK.LIST_CONVERSION_QUEUE, () => ok(listPlaybackConversionJobs()))
  registerIpcHandler(IPC.PLAYBACK.PAUSE_CONVERSION, async (_e, jobId: string) =>
    ok(await pausePlaybackConversionJob(jobId)),
  )
  registerIpcHandler(IPC.PLAYBACK.RESUME_CONVERSION, async (_e, jobId: string) =>
    ok(await resumePlaybackConversionJob(jobId)),
  )
  registerIpcHandler(IPC.PLAYBACK.REMOVE_CONVERSION, async (_e, jobId: string) => {
    await removePlaybackConversionJob(jobId)
    return ok(null)
  })
  registerIpcHandler(IPC.PLAYBACK.START, (_e, libraryId: string, videoId: string) => {
    try {
      return ok(startPlayback(libraryId, videoId))
    } catch (e) {
      log.error({ err: e }, 'playback:start 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(
    IPC.PLAYBACK.HEARTBEAT,
    (_e, libraryId: string, videoId: string, positionSec: number) => {
      try {
        heartbeat(libraryId, videoId, positionSec)
        return ok(null)
      } catch (e) {
        log.error({ err: e }, 'playback:heartbeat 오류')
        return err((e as Error).message)
      }
    },
  )

  registerIpcHandler(
    IPC.PLAYBACK.SEEK,
    (_e, libraryId: string, videoId: string, positionSec: number) => {
      try {
        recordSeek(libraryId, videoId, positionSec)
        return ok(null)
      } catch (e) {
        log.error({ err: e }, 'playback:seek 오류')
        return err((e as Error).message)
      }
    },
  )

  registerIpcHandler(
    IPC.PLAYBACK.END,
    (_e, libraryId: string, videoId: string, positionSec: number) => {
      try {
        endPlayback(libraryId, videoId, positionSec)
        return ok(null)
      } catch (e) {
        log.error({ err: e }, 'playback:end 오류')
        return err((e as Error).message)
      }
    },
  )
}
