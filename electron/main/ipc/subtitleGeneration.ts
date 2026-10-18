import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import { getSubtitleEngineInfo } from '../services/SubtitleRuntime'
import {
  getSubtitleSetupStatus,
  checkSubtitleSetup,
  startSubtitleSetup,
  cancelSubtitleSetup,
} from '../services/SubtitleSetupService'
import {
  getCloudTranslationSettings,
  updateCloudTranslationSettings,
} from '../services/CloudTranslationService'
import {
  cancelSubtitleGeneration,
  getSubtitleGenerationStatus,
  startSubtitleGeneration,
  regenerateSubtitles,
  listSubtitleQueue,
  getSubtitleConcurrency,
  setSubtitleConcurrency,
  pauseSubtitleJob,
  resumeSubtitleJob,
  removeSubtitleJob,
} from '../services/SubtitleGenerationService'

export function registerSubtitleGenerationHandlers(): void {
  registerIpcHandler(IPC.SUBTITLES.GET_SETUP_STATUS, () => ok(getSubtitleSetupStatus()))
  registerIpcHandler(IPC.SUBTITLES.CHECK_SETUP, () => ok(checkSubtitleSetup()))
  registerIpcHandler(IPC.SUBTITLES.START_SETUP, () => ok(startSubtitleSetup()))
  registerIpcHandler(IPC.SUBTITLES.CANCEL_SETUP, () => ok(cancelSubtitleSetup()))
  registerIpcHandler(IPC.SUBTITLES.GET_TRANSLATION_SETTINGS, () =>
    ok(getCloudTranslationSettings()),
  )
  registerIpcHandler(IPC.SUBTITLES.UPDATE_TRANSLATION_SETTINGS, (_event, patch) =>
    ok(updateCloudTranslationSettings(patch)),
  )
  registerIpcHandler(IPC.SUBTITLES.LIST_QUEUE, () => ok(listSubtitleQueue()))
  registerIpcHandler(IPC.SUBTITLES.GET_CONCURRENCY, () => ok(getSubtitleConcurrency()))
  registerIpcHandler(IPC.SUBTITLES.SET_CONCURRENCY, (_event, limit) =>
    ok(setSubtitleConcurrency(limit)),
  )
  registerIpcHandler(IPC.SUBTITLES.PAUSE_JOB, async (_event, jobId) =>
    ok(await pauseSubtitleJob(jobId)),
  )
  registerIpcHandler(IPC.SUBTITLES.RESUME_JOB, (_event, jobId) => ok(resumeSubtitleJob(jobId)))
  registerIpcHandler(IPC.SUBTITLES.REMOVE_JOB, async (_event, jobId) =>
    ok(await removeSubtitleJob(jobId)),
  )
  registerIpcHandler(IPC.SUBTITLES.GET_ENGINE_INFO, async () => ok(await getSubtitleEngineInfo()))
  registerIpcHandler(IPC.SUBTITLES.GENERATE, (_event, libraryId, videoId, options) =>
    ok(startSubtitleGeneration(libraryId, videoId, options)),
  )
  registerIpcHandler(IPC.SUBTITLES.REGENERATE, async (_event, libraryId, videoId, ids, options) =>
    ok(await regenerateSubtitles(libraryId, videoId, ids, options)),
  )
  registerIpcHandler(IPC.SUBTITLES.GET_GENERATION_STATUS, (_event, libraryId, videoId) =>
    ok(getSubtitleGenerationStatus(libraryId, videoId)),
  )
  registerIpcHandler(IPC.SUBTITLES.CANCEL_GENERATION, (_event, libraryId, videoId) =>
    ok(cancelSubtitleGeneration(libraryId, videoId)),
  )
}
