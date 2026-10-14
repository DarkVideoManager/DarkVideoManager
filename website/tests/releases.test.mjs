import assert from 'node:assert/strict'
import test from 'node:test'
import { createReleaseService } from '../lib/releases.js'
import { createReleasesHandler } from '../api/releases.js'

const API = 'https://api.github.com/repos/DarkVideoManager/DarkVideoManager'
const WEB = 'https://github.com/DarkVideoManager/DarkVideoManager/releases'
const NOW = Date.parse('2026-10-15T00:00:00Z')

function release(id, version = `0.2.${id}`, patch = {}) {
  return {
    id,
    tag_name: `v${version}`,
    html_url: `${WEB}/tag/v${version}`,
    published_at: '2026-10-14T12:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
    ...patch,
  }
}

function asset(version, kind, count, patch = {}) {
  const name = `DarkVideoManager-${kind}-${version}-x64.exe`
  return {
    id: kind === 'Setup' ? 101 : 102,
    name,
    state: 'uploaded',
    download_count: count,
    browser_download_url: `${WEB}/download/v${version}/${name}`,
    ...patch,
  }
}

function sourceAsset(id) {
  return { id, name: `source-${id}.tar.gz`, state: 'uploaded', download_count: 999_999 }
}

function fixture() {
  const latest = release(3)
  const older = release(2)
  const state = {
    latest,
    releasePages: [[latest, older]],
    assets: new Map([
      [3, [[asset('0.2.3', 'Setup', 11), asset('0.2.3', 'Portable', 7)]]],
      [2, [[asset('0.2.2', 'Setup', 20), asset('0.2.2', 'Portable', 2)]]],
    ]),
    calls: [],
    fail: false,
    errorBodyReads: 0,
    nextLink: null,
  }
  state.fetch = async (rawUrl, options) => {
    const url = new URL(rawUrl)
    state.calls.push({ url: rawUrl, options })
    assert.equal(url.origin, 'https://api.github.com')
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(
      Object.keys(options.headers).some((key) => /authorization/i.test(key)),
      false,
    )
    if (state.fail) {
      return {
        status: 429,
        json: () => {
          state.errorBodyReads++
          throw new Error('upstream body must not be read')
        },
      }
    }
    const endpoint = url.pathname.slice(new URL(API).pathname.length)
    if (endpoint === '/releases/latest') return Response.json(state.latest)
    const assetMatch = /^\/releases\/(\d+)\/assets$/.exec(endpoint)
    const pages =
      endpoint === '/releases'
        ? state.releasePages
        : assetMatch && state.assets.get(Number(assetMatch[1]))
    assert.ok(pages, `Unexpected metadata request: ${endpoint}`)
    const page = Number(url.searchParams.get('page') || 1)
    assert.equal(url.searchParams.get('per_page'), '100')
    const headers = {}
    if (page < pages.length) {
      headers.link = `<${state.nextLink || `${API}${endpoint}?per_page=100&page=${page + 1}`}>; rel="next"`
    }
    return Response.json(pages[page - 1] || [], { headers })
  }
  return state
}

test('uses latest official links and sums only matching uploaded installers across official versions', async () => {
  const state = fixture()
  state.latest.assets = [asset('0.2.3', 'Setup', 9999)]
  state.releasePages[0].push(
    release(4, '0.3.0', { prerelease: true }),
    release(5, '0.4.0', { draft: true }),
  )
  state.assets
    .get(3)[0]
    .push(
      sourceAsset(400),
      { ...sourceAsset(401), name: 'README.txt' },
      asset('0.2.2', 'Setup', 700, { id: 402 }),
      asset('0.2.3', 'Setup', 800, { id: 403, name: 'DarkVideoManager-Setup-0.2.3-arm64.exe' }),
    )
  const get = createReleaseService({ fetchImpl: state.fetch, now: () => NOW })
  const value = await get()
  assert.equal(value.version, '0.2.3')
  assert.equal(value.releaseUrl, `${WEB}/tag/v0.2.3`)
  assert.equal(value.publishedAt, state.latest.published_at)
  assert.equal(value.checkedAt, new Date(NOW).toISOString())
  assert.deepEqual(value.downloads.setup, {
    url: `${WEB}/download/v0.2.3/DarkVideoManager-Setup-0.2.3-x64.exe`,
    count: 11,
  })
  assert.deepEqual(value.totals, { setup: 31, portable: 9, total: 40 })
  assert.equal(value.releaseCount, 2)
  assert.equal(state.calls.length, 4)
})

test('shares in-flight work, isolates cached responses and updates links after a new release', async () => {
  const state = fixture()
  let now = NOW
  const get = createReleaseService({ fetchImpl: state.fetch, now: () => now, cacheTtlMs: 100 })
  const [one, two, three] = await Promise.all([get(), get(), get()])
  assert.deepEqual(one, two)
  assert.deepEqual(two, three)
  assert.equal(state.calls.length, 4)
  one.totals.total = 0
  assert.equal((await get()).totals.total, 40)
  const newer = release(4)
  state.latest = newer
  state.releasePages[0].unshift(newer)
  state.assets.set(4, [[asset('0.2.4', 'Setup', 5), asset('0.2.4', 'Portable', 6)]])
  now += 99
  assert.equal((await get()).version, '0.2.3')
  now++
  const refreshed = await get()
  assert.equal(refreshed.version, '0.2.4')
  assert.equal(
    refreshed.downloads.portable.url,
    `${WEB}/download/v0.2.4/DarkVideoManager-Portable-0.2.4-x64.exe`,
  )
  assert.deepEqual(refreshed.totals, { setup: 36, portable: 15, total: 51 })
})

test('counts release page two and assets beyond the first 100 without double-counting repeated releases', async () => {
  const state = fixture()
  const older = state.releasePages[0][1]
  state.releasePages = [[state.latest], [state.latest, older]]
  state.assets.set(3, [
    Array.from({ length: 100 }, (_, i) => sourceAsset(1000 + i)),
    [asset('0.2.3', 'Setup', 11), asset('0.2.3', 'Portable', 7)],
  ])
  const value = await createReleaseService({ fetchImpl: state.fetch })()
  assert.deepEqual(value.totals, { setup: 31, portable: 9, total: 40 })
  assert.equal(value.releaseCount, 2)
  assert.ok(state.calls.some(({ url }) => url === `${API}/releases?per_page=100&page=2`))
  assert.ok(state.calls.some(({ url }) => url === `${API}/releases/3/assets?per_page=100&page=2`))
})

test('includes latest exactly once when a release is published between list and latest requests', async () => {
  const state = fixture()
  state.releasePages[0].shift()
  const value = await createReleaseService({ fetchImpl: state.fetch })()
  assert.equal(value.releaseCount, 2)
  assert.equal(value.totals.total, 40)
})

test('represents a missing download format as null, permits genuine zero counts and rejects no installers', async () => {
  const state = fixture()
  state.assets.set(3, [[asset('0.2.3', 'Setup', 0)]])
  const value = await createReleaseService({ fetchImpl: state.fetch })()
  assert.deepEqual(value.downloads.portable, null)
  assert.equal(value.downloads.setup.count, 0)
  assert.deepEqual(value.totals, { setup: 20, portable: 2, total: 22 })
  state.assets.set(3, [[sourceAsset(1000), asset('0.2.3', 'Setup', 1, { state: 'starter' })]])
  await assert.rejects(createReleaseService({ fetchImpl: state.fetch })(), /unavailable/)
})

test('rejects cross-host, cross-repository and wrong-tag links and invalid download counts', async () => {
  for (const patch of [
    { browser_download_url: 'https://example.com/setup.exe' },
    { browser_download_url: 'https://github.com/other/project/releases/download/v0.2.3/setup.exe' },
    { browser_download_url: `${WEB}/download/v0.2.2/DarkVideoManager-Setup-0.2.3-x64.exe` },
    { download_count: -1 },
    { download_count: 1.5 },
    { download_count: '12' },
    { download_count: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const state = fixture()
    Object.assign(state.assets.get(3)[0][0], patch)
    await assert.rejects(createReleaseService({ fetchImpl: state.fetch })(), /unavailable/)
  }
  const state = fixture()
  state.assets.get(3)[0][0].download_count = Number.MAX_SAFE_INTEGER
  await assert.rejects(createReleaseService({ fetchImpl: state.fetch })(), /unavailable/)
})

test('fails closed on unsafe pagination, a pagination limit and malformed successful responses', async () => {
  const state = fixture()
  state.releasePages.push([])
  state.nextLink = 'https://example.com/anything?per_page=100&page=2'
  await assert.rejects(createReleaseService({ fetchImpl: state.fetch })(), /unavailable/)
  state.nextLink = null
  await assert.rejects(
    createReleaseService({ fetchImpl: state.fetch, maxPages: 1 })(),
    /unavailable/,
  )
  await assert.rejects(
    createReleaseService({ fetchImpl: async () => Response.json({ message: 'invalid' }) })(),
    /unavailable/,
  )
})

test('a rate-limited refresh is not cached as success and never exposes the upstream error body', async () => {
  const state = fixture()
  let now = NOW
  const get = createReleaseService({ fetchImpl: state.fetch, now: () => now, cacheTtlMs: 100 })
  assert.equal((await get()).totals.total, 40)
  now += 100
  state.fail = true
  await assert.rejects(get(), /unavailable/)
  assert.equal(state.errorBodyReads, 0)
  state.fail = false
  state.assets.get(3)[0][0].download_count++
  assert.equal((await get()).totals.total, 41)
})

test('a failure after some assets were counted never returns or caches partial totals', async () => {
  const state = fixture()
  let failOlder = true
  const get = createReleaseService({
    fetchImpl: async (url, options) => {
      if (failOlder && url.includes('/releases/2/assets')) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return new Response(null, { status: 503 })
      }
      return state.fetch(url, options)
    },
  })
  await assert.rejects(get(), /unavailable/)
  failOlder = false
  assert.deepEqual((await get()).totals, { setup: 31, portable: 9, total: 40 })
})

test(
  'request and total deadlines bound both stalled fetches and JSON bodies even if abort is ignored',
  { timeout: 2000 },
  async () => {
    for (const options of [
      { requestTimeoutMs: 15, totalTimeoutMs: 1000 },
      { requestTimeoutMs: 1000, totalTimeoutMs: 15 },
    ]) {
      for (const phase of ['fetch', 'body']) {
        const signals = []
        const get = createReleaseService({
          ...options,
          fetchImpl: (_url, request) => {
            signals.push(request.signal)
            return phase === 'fetch'
              ? new Promise(() => {})
              : Promise.resolve({ status: 200, json: () => new Promise(() => {}) })
          },
        })
        await assert.rejects(get(), /unavailable/)
        assert.ok(signals.length > 0 && signals.every((signal) => signal.aborted))
      }
    }
  },
)

function responseRecorder() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
}

test('HTTP GET/HEAD have cache headers, other methods fail without fetching, and errors are generic no-store 503s', async () => {
  let calls = 0
  const handler = createReleasesHandler(async () => {
    calls++
    return { version: '0.2.3' }
  })
  for (const method of ['GET', 'HEAD']) {
    const res = responseRecorder()
    await handler({ method }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=60')
    assert.equal(
      res.headers['vercel-cdn-cache-control'],
      'public,s-maxage=600,stale-while-revalidate=3600',
    )
    assert.equal(res.body, method === 'HEAD' ? undefined : '{"version":"0.2.3"}')
  }
  const rejected = responseRecorder()
  await handler({ method: 'POST' }, rejected)
  assert.equal(calls, 2)
  assert.equal(rejected.statusCode, 405)
  assert.equal(rejected.headers.allow, 'GET, HEAD')
  assert.equal(rejected.headers['cache-control'], 'no-store')
  const failed = createReleasesHandler(async () => {
    throw new Error('synthetic upstream detail')
  })
  for (const method of ['GET', 'HEAD']) {
    const res = responseRecorder()
    await failed({ method }, res)
    assert.equal(res.statusCode, 503)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store')
    assert.equal(
      res.body,
      method === 'HEAD' ? undefined : '{"error":"다운로드 정보를 잠시 불러올 수 없습니다."}',
    )
  }
})
