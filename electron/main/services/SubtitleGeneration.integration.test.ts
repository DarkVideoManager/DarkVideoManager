import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.root, getAppPath: () => process.cwd(), isPackaged: false },
}))
vi.mock('../infra/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
import { getSubtitleEngineInfo } from './SubtitleRuntime'
import { getSubtitleGenerationStatus, startSubtitleGeneration } from './SubtitleGenerationService'
import { drainLibraryWork } from './LibraryWorkService'
import { closeAllDatabases, openDatabase } from '../db/connection'
import { runMigrations } from '../db/migrator'
import { VideoRepository } from '../db/repositories/VideoRepository'
import { SubtitleRepository } from '../db/repositories/SubtitleRepository'

// Opt-in because this invokes real WSL inference and sends the supplied fixture's text for translation.
it.skipIf(!process.env.DVM_SUBTITLE_SMOKE_INPUT)(
  'generates original and Korean subtitles from a real speech video through WSL',
  async () => {
    state.root = mkdtempSync(join(tmpdir(), 'dvm-subtitle-integration-'))
    const target = resolve(state.root)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !target.includes('dvm-subtitle-integration-')
    )
      throw new Error('Unsafe cleanup path')
    try {
      const engine = await getSubtitleEngineInfo()
      expect(engine.available, engine.message).toBe(true)
      const videoPath = join(state.root, "테스트 영상 ' & $.mp4")
      copyFileSync(process.env.DVM_SUBTITLE_SMOKE_INPUT!, videoPath)
      const db = openDatabase('integration', ':memory:')
      runMigrations(db, ':memory:')
      new VideoRepository(db).insert({
        id: 'speech',
        fileName: 'speech.mp4',
        filePath: videoPath,
        rating: 0,
        memo: '',
        resumePosSec: 0,
      })
      startSubtitleGeneration('integration', 'speech', {
        model: 'base',
        language: 'en',
        translateToKorean: true,
      })
      await vi.waitFor(
        () => {
          const job = getSubtitleGenerationStatus('integration', 'speech')!
          expect(['completed', 'failed', 'cancelled']).toContain(job.phase)
        },
        { timeout: 180_000, interval: 500 },
      )
      const job = getSubtitleGenerationStatus('integration', 'speech')!
      expect(job.phase, job.message).toBe('completed')
      expect(job.outputPaths).toHaveLength(2)
      expect(readFileSync(job.outputPaths![0], 'utf8')).toMatch(/subtitle/i)
      expect(readFileSync(job.outputPaths![1], 'utf8')).toMatch(/[가-힣]/)
      const tracks = new SubtitleRepository(db).findByVideoId('speech')
      expect(tracks.map((track) => track.lang).sort()).toEqual(['en', 'ko'])
    } finally {
      await drainLibraryWork()
      closeAllDatabases()
      rmSync(target, { recursive: true, force: true })
    }
  },
  210_000,
)
