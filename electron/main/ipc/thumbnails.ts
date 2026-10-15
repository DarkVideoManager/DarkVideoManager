import { IPC } from '@shared/ipc'
import { registerIpcHandler } from './index'
import { ok, err } from '@shared/result'
import {
  getThumbnailsForVideo,
  setPrimaryThumbnail,
  ensureThumbnailForVideo,
  captureThumbnailAtTime,
  saveThumbnailImageCapture,
} from '../services/ThumbnailService'
import { createLogger } from '../infra/logger'
import { listThumbnailJobs, cancelThumbnailJob } from '../services/ThumbnailJobService'

const log = createLogger('ipc:thumbnails')

export function registerThumbnailHandlers(): void {
  registerIpcHandler(IPC.THUMBNAILS.LIST_JOBS, (_event, libraryId) =>
    ok(listThumbnailJobs(libraryId)),
  )
  registerIpcHandler(IPC.THUMBNAILS.CANCEL_FOR_VIDEO, (_event, libraryId, videoId) =>
    ok(cancelThumbnailJob(libraryId, videoId)),
  )
  registerIpcHandler(
    IPC.THUMBNAILS.ENSURE_FOR_VIDEO,
    async (event, libraryId, videoId, force = false) =>
      ok(await ensureThumbnailForVideo(libraryId, videoId, event.sender, force)),
  )
  registerIpcHandler(
    IPC.THUMBNAILS.CAPTURE_AT_TIME,
    async (event, libraryId, videoId, timeSec, makePrimary = true) =>
      ok(
        await captureThumbnailAtTime(libraryId, videoId, timeSec, event.sender, true, makePrimary),
      ),
  )
  registerIpcHandler(
    IPC.THUMBNAILS.SAVE_IMAGE_CAPTURE,
    (event, libraryId, videoId, timeSec, dataUrl, makePrimary = true) =>
      ok(
        saveThumbnailImageCapture(libraryId, videoId, timeSec, dataUrl, event.sender, makePrimary),
      ),
  )
  registerIpcHandler(IPC.THUMBNAILS.GET_FOR_VIDEO, (_e, libraryId: string, videoId: string) => {
    try {
      return ok(getThumbnailsForVideo(libraryId, videoId))
    } catch (e) {
      log.error({ err: e }, 'thumbnails:getForVideo 오류')
      return err((e as Error).message)
    }
  })

  registerIpcHandler(
    IPC.THUMBNAILS.SET_PRIMARY,
    (_e, libraryId: string, thumbnailId: string, videoId: string) => {
      try {
        setPrimaryThumbnail(libraryId, thumbnailId, videoId)
        return ok(null)
      } catch (e) {
        log.error({ err: e }, 'thumbnails:setPrimary 오류')
        return err((e as Error).message)
      }
    },
  )
}
