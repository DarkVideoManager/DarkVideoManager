// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import type { WindowApi } from '../../../electron/preload'

function getApi() {
  return window.api
}
const libraryApi: WindowApi['library'] = {
  list: () => getApi().library.list(),
  open: (id2) => getApi().library.open(id2),
  create: (name, folderPath) => getApi().library.create(name, folderPath),
  close: (id2) => getApi().library.close(id2),
  delete: (id2) => getApi().library.delete(id2),
  selectFolder: () => getApi().library.selectFolder(),
  importFolder: (id2, folder) => getApi().library.importFolder(id2, folder),
  selectFiles: () => getApi().library.selectFiles(),
  importFiles: (id2, files) => getApi().library.importFiles(id2, files),
  refresh: (id2) => getApi().library.refresh(id2),
  cancelWork: (id2) => getApi().library.cancelWork(id2),
}
const videosApi: WindowApi['videos'] = {
  metadataOptions: (libraryId, removed) => getApi().videos.metadataOptions(libraryId, removed),
  search: (libraryId, query) => getApi().videos.search(libraryId, query),
  get: (libraryId, videoId) => getApi().videos.get(libraryId, videoId),
  revealSource: (libraryId, videoId) => getApi().videos.revealSource(libraryId, videoId),
  getPlaybackSource: (libraryId, videoId) => getApi().videos.getPlaybackSource(libraryId, videoId),
  getNativePlayerInfo: () => getApi().videos.getNativePlayerInfo(),
  openInNativePlayer: (libraryId, videoId, options) =>
    getApi().videos.openInNativePlayer(libraryId, videoId, options),
  seekActivePlayback: (libraryId, videoId, timeSec) =>
    getApi().videos.seekActivePlayback(libraryId, videoId, timeSec),
  updateMeta: (libraryId, videoId, meta) => getApi().videos.updateMeta(libraryId, videoId, meta),
  delete: (libraryId, videoId, mode) => getApi().videos.delete(libraryId, videoId, mode),
  restore: (libraryId, videoId) => getApi().videos.restore(libraryId, videoId),
}
const thumbnailsApi: WindowApi['thumbnails'] = {
  listJobs: (libraryId) => getApi().thumbnails.listJobs(libraryId),
  cancelForVideo: (libraryId, videoId) => getApi().thumbnails.cancelForVideo(libraryId, videoId),
  getForVideo: (libraryId, videoId) => getApi().thumbnails.getForVideo(libraryId, videoId),
  setPrimary: (libraryId, thumbnailId, videoId) =>
    getApi().thumbnails.setPrimary(libraryId, thumbnailId, videoId),
  ensureForVideo: (libraryId, videoId, force = false) =>
    getApi().thumbnails.ensureForVideo(libraryId, videoId, force),
  captureAtTime: (libraryId, videoId, timeSec, makePrimary = true) =>
    getApi().thumbnails.captureAtTime(libraryId, videoId, timeSec, makePrimary),
  saveImageCapture: (libraryId, videoId, timeSec, dataUrl, makePrimary = true) =>
    getApi().thumbnails.saveImageCapture(libraryId, videoId, timeSec, dataUrl, makePrimary),
}
const dataImportApi: WindowApi['dataImport'] = {
  selectCsv: () => getApi().dataImport.selectCsv(),
  preview: (libraryId, csvPath) => getApi().dataImport.preview(libraryId, csvPath),
  importCsv: (libraryId, csvPath, options) =>
    getApi().dataImport.importCsv(libraryId, csvPath, options),
}

const playbackApi: WindowApi['playback'] = {
  listConversionQueue: () => getApi().playback.listConversionQueue(),
  pauseConversion: (jobId) => getApi().playback.pauseConversion(jobId),
  resumeConversion: (jobId) => getApi().playback.resumeConversion(jobId),
  removeConversion: (jobId) => getApi().playback.removeConversion(jobId),
  start: (libraryId, videoId) => getApi().playback.start(libraryId, videoId),
  heartbeat: (libraryId, videoId, positionSec) =>
    getApi().playback.heartbeat(libraryId, videoId, positionSec),
  seek: (libraryId, videoId, positionSec) =>
    getApi().playback.seek(libraryId, videoId, positionSec),
  end: (libraryId, videoId, positionSec) => getApi().playback.end(libraryId, videoId, positionSec),
}

export { libraryApi, videosApi, thumbnailsApi, dataImportApi, playbackApi }
