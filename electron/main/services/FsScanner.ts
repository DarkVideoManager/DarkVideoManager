import { opendir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isVideoFile } from '../infra/fs'
import { throwIfWorkCancelled, yieldLibraryWork } from './LibraryWorkService'

export interface ScanProgress {
  files: number
  directories: number
  currentPath: string
}
export interface ScanOptions {
  signal?: AbortSignal
  onFile?: (filePath: string) => void
  onProgress?: (progress: ScanProgress) => void
}

const driveMetadataDirectories = new Set(['$recycle.bin', 'system volume information'])
export function isDriveMetadataDirectory(root: string, currentPath: string, name: string): boolean {
  const resolvedRoot = resolve(root)
  return (
    process.platform === 'win32' &&
    /^[a-z]:[\\/]$/i.test(resolvedRoot) &&
    resolve(currentPath) === resolvedRoot &&
    driveMetadataDirectories.has(name.toLowerCase())
  )
}

/** Errors abort the complete traversal; an unreadable folder is never an empty snapshot. */
export class FsScanner {
  async scan(dirPath: string, options: ScanOptions = {}): Promise<string[]> {
    const results: string[] = []
    const pending = [dirPath]
    let files = 0,
      directories = 0,
      batchEntries = 0
    let yieldedAt = Date.now()
    throwIfWorkCancelled(options.signal)
    while (pending.length) {
      throwIfWorkCancelled(options.signal)
      const currentPath = pending.pop()!
      const directory = await opendir(currentPath)
      directories++
      // for-await closes the directory handle on completion, exception or cancellation.
      for await (const entry of directory) {
        throwIfWorkCancelled(options.signal)
        if (!entry.name.startsWith('.')) {
          const fullPath = join(currentPath, entry.name)
          if (entry.isDirectory()) {
            if (!isDriveMetadataDirectory(dirPath, currentPath, entry.name)) pending.push(fullPath)
          } else if (entry.isFile()) {
            files++
            options.onFile?.(fullPath)
            if (isVideoFile(fullPath)) results.push(fullPath)
          }
        }
        if (++batchEntries >= 64 || Date.now() - yieldedAt >= 8) {
          options.onProgress?.({ files, directories, currentPath })
          await yieldLibraryWork(options.signal)
          batchEntries = 0
          yieldedAt = Date.now()
        }
      }
      options.onProgress?.({ files, directories, currentPath })
    }
    throwIfWorkCancelled(options.signal)
    return results
  }
}
