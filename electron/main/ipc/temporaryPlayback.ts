import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { registerIpcHandler } from './index'
import { openTemporaryPlayback, closeTemporaryPlayback } from '../services/TemporaryPlaybackService'
import { closeAllMpvSessions } from '../services/MpvSessionService.js'
import { closeManagedNativePlayers } from '../services/NativePlayerService'

export function registerTemporaryPlaybackHandlers(): void {
  const watched = new WeakSet<Electron.WebContents>()
  registerIpcHandler(IPC.TEMPORARY_PLAYBACK.OPEN, (event, filePath) => {
    const media = openTemporaryPlayback(event.sender.id, filePath)
    closeAllMpvSessions()
    closeManagedNativePlayers()
    if (!watched.has(event.sender)) {
      watched.add(event.sender)
      const owner = event.sender.id
      event.sender.once('destroyed', () => closeTemporaryPlayback(owner))
      event.sender.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) closeTemporaryPlayback(owner)
      })
    }
    return ok(media)
  })
  registerIpcHandler(IPC.TEMPORARY_PLAYBACK.CLOSE, (event, token) => {
    closeTemporaryPlayback(event.sender.id, token)
    return ok(null)
  })
}
