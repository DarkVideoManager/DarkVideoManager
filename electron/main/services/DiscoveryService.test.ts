import { beforeEach, expect, it, vi } from 'vitest'
import type { Config } from '@shared/types'
const state = vi.hoisted(() => ({
  config: { libraries: [] } as Config,
  db: {} as object | null,
  save: vi.fn(),
  video: { id: 'v', removalMode: undefined as string | undefined },
}))
vi.mock('../infra/config', () => ({
  loadConfig: () => state.config,
  updateConfig: (change: (config: Config) => Config) => {
    state.save()
    state.config = change(state.config)
  },
}))
vi.mock('../db/connection', () => ({ getDatabase: () => state.db }))
vi.mock('../db/repositories/VideoRepository', () => ({
  VideoRepository: class {
    findById() {
      return state.video
    }
    listAll() {
      return []
    }
  },
}))
import {
  getDiscoveryPreferences,
  setDiscoveryFavorite,
  setDiscoveryTags,
  queryDiscovery,
} from './DiscoveryService'
beforeEach(() => {
  state.config = {
    libraries: ['a', 'b'].map((id) => ({
      id,
      name: id,
      dbPath: id,
      folderPath: id,
      createdAt: '2026-10-15',
    })),
  }
  state.db = {}
  state.video = { id: 'v', removalMode: undefined }
  state.save.mockReset()
})
it('isolates favorite and preferred tag changes by library and keeps unrelated fields', () => {
  state.config.cacheLimitGb = 8
  setDiscoveryFavorite('a', 'v', true)
  setDiscoveryTags('a', ['Football', 'Football'])
  expect(getDiscoveryPreferences('a')).toEqual({
    favoriteVideoIds: ['v'],
    preferredTags: ['Football'],
  })
  expect(getDiscoveryPreferences('b')).toEqual({ favoriteVideoIds: [], preferredTags: [] })
  expect(state.config.cacheLimitGb).toBe(8)
  setDiscoveryFavorite('a', 'v', false)
  expect(getDiscoveryPreferences('a').favoriteVideoIds).toEqual([])
})
it('rejects unknown, closed or removed videos rather than persisting stale preference changes', () => {
  expect(() => setDiscoveryFavorite('missing', 'v', true)).toThrow('등록된')
  state.db = null
  expect(() => queryDiscovery('a', { text: '', page: 1 })).toThrow('라이브러리를 연 뒤')
  state.db = {}
  state.video.removalMode = 'remove'
  expect(() => setDiscoveryFavorite('a', 'v', true)).toThrow('현재 라이브러리')
  expect(state.save).not.toHaveBeenCalled()
})
it('does not mutate the saved list when a later save fails', () => {
  setDiscoveryFavorite('a', 'v', true)
  state.save.mockImplementation(() => {
    throw new Error('write failed')
  })
  expect(() => setDiscoveryFavorite('a', 'v', false)).toThrow('write failed')
  expect(getDiscoveryPreferences('a').favoriteVideoIds).toEqual(['v'])
})
