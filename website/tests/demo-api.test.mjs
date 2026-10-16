import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

// Run the actual adapter, not a copied mock. Node 24 strips its TypeScript syntax.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
})
const { createDemoAdapter } = await import('../demo/api.ts')
const { DEMO_LIBRARY_ID: libraryId, DEMO_STORAGE_KEY: storageKey } = await import('../demo/data.ts')
const { browserCopy } = await import('../demo/browser-copy.ts')
const videoId = 'baseball-1'

class MemoryStorage {
  value = null
  failWrites = false
  getItem(key) {
    return key === storageKey ? this.value : null
  }
  setItem(key, value) {
    assert.equal(key, storageKey)
    if (this.failWrites) throw new Error('quota exceeded')
    this.value = value
  }
  removeItem(key) {
    assert.equal(key, storageKey)
    this.value = null
  }
}

function fixture(t, storage = new MemoryStorage()) {
  const adapter = createDemoAdapter(storage)
  t.after(() => adapter.dispose())
  return { ...adapter, storage }
}

test('demo supplies every current desktop API method, including new pages', (t) => {
  const { api } = fixture(t)
  const source = ts.createSourceFile(
    'preload.ts',
    readFileSync(new URL('../../electron/preload/index.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  let object
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'api')
      object = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(object && ts.isObjectLiteralExpression(object))
  for (const group of object.properties) {
    const groupName = group.name.getText(source)
    for (const method of group.initializer.properties) {
      const methodName = method.name.getText(source)
      if (groupName === 'app' && methodName === 'githubStar') continue // optional desktop promotion
      assert.equal(
        typeof api[groupName]?.[methodName],
        'function',
        `${groupName}.${methodName} is missing`,
      )
    }
  }
})

test('desktop-only actions fail explicitly without network, secrets or saved-data changes', async (t) => {
  const { api, storage } = fixture(t)
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('network must not be used')
  })
  const calls = [
    () => api.videos.setActivePlaybackRate(libraryId, videoId, 1.5),
    () => api.library.selectFiles(),
    () => api.library.importFiles(libraryId, ['C:\\private.mp4']),
    () => api.videos.revealSource(libraryId, videoId),
    () => api.thumbnails.cancelForVideo(libraryId, videoId),
    () => api.discovery.query(libraryId, {}),
    () => api.discovery.favorite(libraryId, videoId, true),
    () => api.discovery.tags(libraryId, ['private']),
    () => api.metadataImport.getSettings(),
    () =>
      api.metadataImport.updateSettings({
        enabled: true,
        baseUrl: 'https://stash.invalid',
        apiKey: 'YOUR_TEST_KEY',
      }),
    () => api.metadataImport.search('private title'),
    () => api.metadataImport.apply(libraryId, videoId, {}),
    () => api.maintenance.previewNames(libraryId, {}),
    () => api.maintenance.applyNames(libraryId, 'preview', [videoId]),
    () => api.maintenance.findDuplicates(libraryId),
    () => api.maintenance.cancel(libraryId),
    () => api.privacy.save({ exitAction: 'website', exitUrl: 'https://private.invalid' }),
  ]
  for (const call of calls) {
    const result = await call()
    assert.equal(result.ok, false)
    assert.match(result.error, /브라우저 데모.*지원하지.*Windows/)
  }
  const unsubscribe = api.on.nativePlayerSpeed(() => { throw new Error('browser must not emit native speed events') })
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
  unsubscribe()
  assert.equal(globalThis.fetch.mock.callCount(), 0)
  assert.equal(storage.value, null)
  assert.deepEqual(await api.thumbnails.listJobs(libraryId), { ok: true, value: [] })
  assert.equal((await api.app.getSettings()).value.seekStepSec, 1)
  assert.equal((await api.privacy.get()).value.exitAction, 'blank')
  assert.deepEqual(await api.privacy.exit(), { ok: true, value: 'blank' })
})

test('v5 saved metadata, captions, history and removals survive category migration and reload', async (t) => {
  const seeded = fixture(t)
  assert.equal(
    (
      await seeded.api.videos.updateMeta(libraryId, videoId, {
        title: '내 제목',
        memo: '기존 메모',
        tags: '기존 태그, Baseball',
        rating: 3.5,
      })
    ).ok,
    true,
  )
  assert.equal((await seeded.api.videos.delete(libraryId, 'baseball-2', 'remove')).ok, true)
  const old = JSON.parse(seeded.storage.value)
  old.version = 5
  for (const video of old.videos) delete video.category
  seeded.storage.value = JSON.stringify(old)
  const migrated = fixture(t, seeded.storage)
  assert.equal(migrated.getStorageError(), null)
  const saved = JSON.parse(seeded.storage.value)
  assert.equal(saved.version, 6)
  assert.deepEqual(saved, {
    ...old,
    version: 6,
    videos: old.videos.map((video) => ({ ...video, category: '' })),
  })
  const reloaded = fixture(t, seeded.storage)
  assert.equal(reloaded.getStorageError(), null)
  assert.equal(
    (await reloaded.api.videos.get(libraryId, videoId)).value.tags,
    '기존 태그, Baseball',
  )
  assert.equal((await reloaded.api.videos.get(libraryId, 'baseball-2')).value.removed, true)
})

test('categories and exact tags can be edited, filtered and suggested without partial edits clearing them', async (t) => {
  const { api } = fixture(t)
  assert.equal(
    (
      await api.videos.updateMeta(libraryId, videoId, {
        category: '  경기  ',
        tags: '#Baseball #Pitch',
        title: '첫 번째 장면',
      })
    ).ok,
    true,
  )
  assert.equal(
    (
      await api.videos.updateMeta(libraryId, 'baseball-2', {
        category: '연습',
        tags: 'Baseball, Pitching',
      })
    ).ok,
    true,
  )
  assert.equal((await api.videos.updateMeta(libraryId, videoId, { rating: 4 })).ok, true)
  assert.equal((await api.videos.get(libraryId, videoId)).value.category, '경기')
  assert.equal((await api.videos.get(libraryId, videoId)).value.tags, 'Baseball, Pitch')
  const filtered = await api.videos.search(libraryId, {
    category: '경기',
    tag: '#pitch',
    q: '첫 #BASEBALL',
  })
  assert.equal(filtered.ok, true)
  assert.deepEqual(
    filtered.value.videos.map((video) => video.id),
    [videoId],
  )
  assert.equal((await api.videos.search(libraryId, { tag: 'Pit' })).value.total, 0)
  assert.equal((await api.videos.search(libraryId, { category: '없는 분류' })).value.total, 0)
  const options = (await api.videos.metadataOptions(libraryId)).value
  assert.ok(options.categories.includes('경기'))
  assert.ok(options.tags.includes('Pitch'))
  await api.videos.delete(libraryId, videoId, 'remove')
  assert.equal(
    (await api.videos.metadataOptions(libraryId)).value.categories.includes('경기'),
    false,
  )
  assert.deepEqual((await api.videos.metadataOptions(libraryId, true)).value.categories, ['경기'])
})

test('older v1 through v4 storage still migrates without losing user metadata or excluded videos', async (t) => {
  for (const version of [1, 2, 3, 4]) {
    const original = fixture(t)
    await original.api.videos.updateMeta(libraryId, videoId, {
      title: '보존할 제목',
      memo: '사용자 메모',
      rating: 2.5,
    })
    await original.api.videos.delete(libraryId, 'baseball-2', 'remove')
    const old = JSON.parse(original.storage.value)
    old.version = version
    for (const video of old.videos) delete video.category
    old.videos.find((video) => video.id === videoId).tags = '#Legacy, unchanged '
    if (version <= 2) {
      for (const field of ['videos', 'highlights', 'thumbnails', 'history', 'tracks', 'jobs'])
        old[field] = old[field].filter(
          (item) => (field === 'videos' ? item.id : item.videoId) !== 'baseball-4',
        )
    }
    if (version === 1) {
      delete old.tracks
      delete old.jobs
    }
    original.storage.value = JSON.stringify(old)
    const migrated = fixture(t, original.storage)
    assert.equal(migrated.getStorageError(), null, `v${version}`)
    const video = (await migrated.api.videos.get(libraryId, videoId)).value
    assert.equal(video.title, '보존할 제목')
    assert.equal(video.memo, '사용자 메모')
    assert.equal(video.tags, '#Legacy, unchanged ')
    assert.equal(video.rating, 2.5)
    assert.equal(video.category, '')
    assert.equal((await migrated.api.videos.get(libraryId, 'baseball-2')).value.removed, true)
    assert.ok((await migrated.api.videos.get(libraryId, 'baseball-4')).value)
  }
})

test('new large-v2 option creates only a clearly labelled browser simulation', async (t) => {
  const { api } = fixture(t)
  const result = await api.subtitles.generate(libraryId, videoId, {
    model: 'large-v2',
    language: 'en',
    translateToKorean: false,
  })
  assert.equal(result.ok, true)
  const job = (await api.subtitles.getGenerationStatus(libraryId, videoId)).value
  assert.equal(job.options.model, 'large-v2')
  assert.match(job.message, /체험|샘플|시뮬레이션/)
})

test('failed category persistence keeps previously saved data and invalid saved data is not overwritten', async (t) => {
  const { api, storage } = fixture(t)
  assert.equal(
    (await api.videos.updateMeta(libraryId, videoId, { category: '보존', tags: '태그' })).ok,
    true,
  )
  const before = storage.value
  storage.failWrites = true
  assert.equal((await api.videos.updateMeta(libraryId, videoId, { category: '실패' })).ok, false)
  assert.equal(storage.value, before)
  assert.equal((await api.videos.get(libraryId, videoId)).value.category, '보존')
  const broken = new MemoryStorage()
  broken.value = '{invalid'
  const fallback = fixture(t, broken)
  assert.ok(fallback.getStorageError())
  assert.equal(
    (await fallback.api.videos.updateMeta(libraryId, videoId, { title: 'overwrite' })).ok,
    false,
  )
  assert.equal(broken.value, '{invalid')
})

test('browser copy transformations still match the actual current renderer', () => {
  const files = [
    'components/library/SubtitleGenerationPanel.jsx',
    'pages/SubtitleQueuePage.jsx',
    'components/player/VideoPlayer.jsx',
    'components/library/DetailPanel.jsx',
    'pages/PlayerPage.jsx',
    'router.tsx',
    'pages/StatsPage.jsx',
    'components/library/SubtitleGuidance.jsx',
    'components/library/SubtitleProcessingStatus.jsx',
  ]
  for (const file of files) {
    const url = new URL(`../../src/renderer/${file}`, import.meta.url)
    const result = browserCopy(readFileSync(url, 'utf8'), url.pathname)
    assert.equal(typeof result, 'string', file)
    if (file.endsWith('/VideoPlayer.jsx')) {
      assert.match(result, /ignoreBrowserPlayerKey\(event, subtitleNavigationTarget\)/)
      assert.match(result, /event\.isComposing/)
      assert.match(result, /aria-modal/)
    }
  }
})
