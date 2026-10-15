import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

const state = vi.hoisted(() => ({ path: '', openExternal: vi.fn() }))
vi.mock('electron', () => ({ shell: { openExternal: state.openExternal } }))
vi.mock('../infra/paths', () => ({ getConfigPath: () => state.path }))

let directory: string
beforeEach(() => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'dvm-star-test-'))
  state.path = join(directory, 'config.json')
  state.openExternal.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('dvm-star-test-'))
    throw new Error('Unsafe cleanup path')
  rmSync(target, { recursive: true, force: true })
})

describe('first-run GitHub quick link', () => {
  it('persists the first display and does not claim it again after a module restart', async () => {
    let service = await import('./GitHubStarService')
    expect(service.claimGitHubStarPrompt()).toBe(true)
    expect(JSON.parse(readFileSync(state.path, 'utf8'))).toEqual({
      libraries: [],
      githubStarPromptShown: true,
    })
    expect(service.claimGitHubStarPrompt()).toBe(false)
    vi.resetModules()
    service = await import('./GitHubStarService')
    expect(service.claimGitHubStarPrompt()).toBe(false)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('offers the new feature once to an existing installation and preserves its settings', async () => {
    const { saveConfig, loadConfig, updateConfig } = await import('../infra/config')
    saveConfig({ libraries: [], cacheLimitGb: 25, nativePlayer: null })
    const service = await import('./GitHubStarService')
    expect(service.claimGitHubStarPrompt()).toBe(true)
    expect(loadConfig()).toEqual({
      libraries: [],
      cacheLimitGb: 25,
      nativePlayer: null,
      githubStarPromptShown: true,
    })
    updateConfig((config) => ({ ...config, cacheLimitGb: 30 }))
    vi.resetModules()
    expect((await import('./GitHubStarService')).claimGitHubStarPrompt()).toBe(false)
    expect((await import('../infra/config')).loadConfig().cacheLimitGb).toBe(30)
  })

  it('does not overwrite a damaged configuration to show the prompt', async () => {
    const damaged = '{"libraries":'
    writeFileSync(state.path, damaged)
    expect((await import('./GitHubStarService')).claimGitHubStarPrompt).toThrow('안전하게 복원')
    expect(readFileSync(state.path, 'utf8')).toBe(damaged)
    expect(state.openExternal).not.toHaveBeenCalled()
  })

  it('opens only the fixed public repository when explicitly invoked', async () => {
    const service = await import('./GitHubStarService')
    expect(state.openExternal).not.toHaveBeenCalled()
    await service.openGitHubRepository()
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(
      'https://github.com/DarkVideoManager/DarkVideoManager',
    )
  })

  it('propagates browser failures without resetting the one-time flag', async () => {
    const service = await import('./GitHubStarService')
    service.claimGitHubStarPrompt()
    state.openExternal.mockRejectedValueOnce(new Error('Browser unavailable'))
    await expect(service.openGitHubRepository()).rejects.toThrow('Browser unavailable')
    expect(service.claimGitHubStarPrompt()).toBe(false)
  })
})
