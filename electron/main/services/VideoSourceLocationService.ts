import { shell } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { getDatabase, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { loadConfig } from '../infra/config'

export async function revealVideoSource(libraryId: string, videoId: string): Promise<void> {
  const library = loadConfig().libraries.find((item) => item.id === libraryId)
  if (!library) throw new Error('원본 영상의 라이브러리를 찾을 수 없습니다.')

  let db = getDatabase(libraryId)
  if (!db) {
    // Restored queue jobs may belong to a library that has not been opened in this session.
    // Reopen only its registered database without changing the user's active library.
    try {
      if (!(await stat(library.dbPath)).isFile()) throw new Error('Not a file')
    } catch {
      throw new Error('원본 영상의 라이브러리 파일에 접근할 수 없습니다.')
    }
    db = openDatabase(libraryId, library.dbPath, { fileMustExist: true })
    runMigrations(db, library.dbPath)
  }

  const video = new VideoRepository(db).findById(videoId)
  if (!video) throw new Error('라이브러리에서 원본 영상을 찾을 수 없습니다.')
  if (!isAbsolute(video.filePath)) throw new Error('원본 영상의 파일 경로가 올바르지 않습니다.')

  let sourcePath: string
  try {
    sourcePath = await realpath(video.filePath)
    if (!(await stat(sourcePath)).isFile()) throw new Error('Not a file')
  } catch {
    throw new Error(
      '원본 영상 파일을 찾거나 읽을 수 없습니다. 파일 이동·삭제 또는 드라이브 연결 상태를 확인해 주세요.',
    )
  }
  // Preserve the imported location, including junctions, after validating its actual file.
  shell.showItemInFolder(video.filePath)
}
