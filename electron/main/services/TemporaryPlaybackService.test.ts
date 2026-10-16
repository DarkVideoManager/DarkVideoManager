import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openTemporaryPlayback,
  closeTemporaryPlayback,
  isTemporaryMediaAllowed,
} from './TemporaryPlaybackService'

vi.mock('electron', () => ({ protocol: {} }))
import { createMediaResponse } from '../infra/localMedia'

const folders: string[] = []
afterEach(() => {
  closeTemporaryPlayback(1)
  closeTemporaryPlayback(2)
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'dvm-temporary-'))
  folders.push(folder)
  const path = join(folder, '한글 영상 #1.MP4')
  writeFileSync(path, 'synthetic media fixture')
  return { folder, path, canonical: realpathSync(path) }
}
describe('temporary playback grants', () => {
  it('preserves active playback when stopping an external player fails and validates before stopping', () => {
    const previous = fixture()
    const next = fixture()
    const first = openTemporaryPlayback(1, previous.path)
    const stop = vi.fn(() => {
      throw new Error('player cannot stop')
    })
    expect(() => openTemporaryPlayback(1, next.path, stop)).toThrow('player cannot stop')
    expect(isTemporaryMediaAllowed(previous.canonical, first.token)).toBe(true)
    expect(() => openTemporaryPlayback(1, join(next.folder, 'missing.mp4'), stop)).toThrow()
    expect(stop).toHaveBeenCalledTimes(1)
  })
  it('serves authorized ranges only until close without granting arbitrary protocol paths', async () => {
    const { path } = fixture()
    const session = openTemporaryPlayback(1, path)
    const response = createMediaResponse(
      new Request(session.sourceUrl, { headers: { Range: 'bytes=0-8' } }),
      () => false,
    )
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('synthetic')
    expect(
      createMediaResponse(
        new Request(session.sourceUrl.replace(session.token, 'invalid')),
        () => false,
      ).status,
    ).toBe(403)
    closeTemporaryPlayback(1)
    expect(createMediaResponse(new Request(session.sourceUrl), () => true).status).toBe(403)
  })
  it('authorizes only the selected canonical video and revokes on replacement/close', () => {
    const { path, canonical } = fixture()
    const first = openTemporaryPlayback(1, path)
    expect(first.fileName).toBe('한글 영상 #1.MP4')
    expect(new URL(first.sourceUrl).searchParams.get('path')).toBe(canonical)
    expect(isTemporaryMediaAllowed(canonical, first.token)).toBe(true)
    expect(isTemporaryMediaAllowed(canonical + '.txt', first.token)).toBe(false)
    const second = openTemporaryPlayback(1, path)
    expect(isTemporaryMediaAllowed(canonical, first.token)).toBe(false)
    closeTemporaryPlayback(1, first.token)
    closeTemporaryPlayback(2, second.token)
    expect(isTemporaryMediaAllowed(canonical, second.token)).toBe(true)
    closeTemporaryPlayback(1, second.token)
    expect(isTemporaryMediaAllowed(canonical, second.token)).toBe(false)
  })
  it('rejects missing files, folders, non-video files, remote/device paths and commands', () => {
    const { path, folder, canonical } = fixture()
    const first = openTemporaryPlayback(1, path)
    for (const input of [
      join(folder, 'absent.mp4'),
      folder,
      join(folder, 'readme.txt'),
      'https://example.com/video.mp4',
      'file:///C:/video.mp4',
      '\\\\server\\video.mp4',
      '\\\\?\\C:\\video.mp4',
      'cmd /c calc.mp4',
      'C:\\video.mp4:secret.mp4',
    ]) {
      expect(() => openTemporaryPlayback(1, input), input).toThrow()
    }
    expect(isTemporaryMediaAllowed(canonical, first.token)).toBe(true)
    rmSync(path)
    expect(isTemporaryMediaAllowed(canonical, first.token)).toBe(false)
  })
})
