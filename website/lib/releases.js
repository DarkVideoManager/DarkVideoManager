const REPOSITORY = 'doodoocompany/DarkVideoManager'
const API = `https://api.github.com/repos/${REPOSITORY}`
const RELEASES = `https://github.com/${REPOSITORY}/releases`
const PAGE_SIZE = 100
const FAILURE = 'Release information unavailable'

function requireValid(condition) {
  if (!condition) throw new Error(FAILURE)
}

function releaseIdentity(release) {
  requireValid(release && Number.isSafeInteger(release.id) && release.id > 0)
  requireValid(typeof release.draft === 'boolean' && typeof release.prerelease === 'boolean')
  if (release.draft || release.prerelease || release.published_at === null) return null
  requireValid(
    typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)),
  )
  const version = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(release.tag_name)
  requireValid(version)
  const releaseUrl = `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}`
  requireValid(release.html_url === releaseUrl)
  return { version: version[1], releaseUrl }
}

function selectDownloads(release, assets) {
  const { version } = releaseIdentity(release)
  const downloads = { setup: null, portable: null }
  for (const asset of assets) {
    requireValid(asset && typeof asset.name === 'string')
    const kind = ['setup', 'portable'].find(
      (type) =>
        asset.name ===
        `DarkVideoManager-${type === 'setup' ? 'Setup' : 'Portable'}-${version}-x64.exe`,
    )
    if (!kind || asset.state !== 'uploaded') continue
    requireValid(Number.isSafeInteger(asset.download_count) && asset.download_count >= 0)
    requireValid(downloads[kind] === null)
    const url = `${RELEASES}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`
    // Only the exact asset in this repository/tag may become a public download link.
    requireValid(asset.browser_download_url === url)
    downloads[kind] = { url, count: asset.download_count }
  }
  return downloads
}

function addCount(total, count) {
  const sum = total + count
  requireValid(Number.isSafeInteger(sum) && sum >= 0)
  return sum
}

function hasNextPage(response, endpoint, page, length) {
  const link = response.headers.get('link') || ''
  const next = link.split(',').find((part) => /;\s*rel="next"/.test(part))
  if (!next) return length === PAGE_SIZE
  const match = /^\s*<([^>]+)>/.exec(next)
  requireValid(match)
  const url = new URL(match[1])
  requireValid(
    url.origin + url.pathname === `${API}${endpoint}` &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.searchParams.get('per_page') === String(PAGE_SIZE) &&
      url.searchParams.get('page') === String(page + 1) &&
      [...url.searchParams.keys()].every((key) => ['page', 'per_page'].includes(key)),
  )
  return true
}

async function loadSummary({ fetchImpl, now, requestTimeoutMs, totalTimeoutMs, maxPages }) {
  const lifetime = new AbortController()
  const totalTimer = setTimeout(() => lifetime.abort(), totalTimeoutMs)

  async function get(endpoint) {
    requireValid(!lifetime.signal.aborted)
    const controller = new AbortController()
    const onDeadline = () => controller.abort()
    lifetime.signal.addEventListener('abort', onDeadline, { once: true })
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    const aborted = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error(FAILURE)), { once: true })
    })
    try {
      return await Promise.race([
        aborted,
        (async () => {
          const response = await fetchImpl(`${API}${endpoint}`, {
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
              'User-Agent': 'DarkVideoManager-website',
            },
            redirect: 'error',
            signal: controller.signal,
          })
          // Never read, log or return an upstream error body.
          requireValid(response.status === 200)
          return { response, data: await response.json() }
        })(),
      ])
    } finally {
      clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', onDeadline)
    }
  }

  async function list(endpoint) {
    const items = new Map()
    for (let page = 1; page <= maxPages; page++) {
      const { response, data } = await get(
        `${endpoint}?per_page=${PAGE_SIZE}${page === 1 ? '' : `&page=${page}`}`,
      )
      requireValid(Array.isArray(data) && data.length <= PAGE_SIZE)
      for (const item of data) {
        requireValid(item && Number.isSafeInteger(item.id) && item.id > 0)
        items.set(item.id, item)
      }
      if (!hasNextPage(response, endpoint, page, data.length)) return [...items.values()]
    }
    throw new Error(FAILURE)
  }

  try {
    const [{ data: latest }, listed] = await Promise.all([
      get('/releases/latest'),
      list('/releases'),
    ])
    const identity = releaseIdentity(latest)
    requireValid(identity)
    const official = new Map()
    for (const release of listed) {
      if (releaseIdentity(release)) official.set(release.id, release)
    }
    // Publication may occur between the two API requests; include latest exactly once.
    official.set(latest.id, latest)
    const releases = [...official.values()]
    const totals = { setup: 0, portable: 0, total: 0 }
    let latestDownloads
    let index = 0
    async function worker() {
      while (index < releases.length) {
        const release = releases[index++]
        // The separate endpoint is paginated even if the inline assets array is truncated.
        const assets = await list(`/releases/${release.id}/assets`)
        const downloads = selectDownloads(release, assets)
        for (const type of ['setup', 'portable']) {
          totals[type] = addCount(totals[type], downloads[type]?.count ?? 0)
        }
        if (release.id === latest.id) latestDownloads = downloads
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, releases.length) }, worker))
    requireValid(latestDownloads?.setup || latestDownloads?.portable)
    totals.total = addCount(totals.setup, totals.portable)
    requireValid(!lifetime.signal.aborted)
    return {
      ...identity,
      publishedAt: latest.published_at,
      checkedAt: new Date(now()).toISOString(),
      downloads: latestDownloads,
      totals,
      releaseCount: releases.length,
    }
  } finally {
    clearTimeout(totalTimer)
    lifetime.abort()
  }
}

export function createReleaseService({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheTtlMs = 10 * 60 * 1000,
  requestTimeoutMs = 12_000,
  totalTimeoutMs = 20_000,
  maxPages = 100,
} = {}) {
  let cached
  let expiresAt = 0
  let pending
  return async function getReleaseSummary() {
    if (cached && now() < expiresAt) return structuredClone(cached)
    if (!pending) {
      pending = loadSummary({ fetchImpl, now, requestTimeoutMs, totalTimeoutMs, maxPages })
        .then((summary) => {
          cached = summary
          expiresAt = now() + cacheTtlMs
          return summary
        })
        .finally(() => {
          pending = undefined
        })
    }
    // A failed refresh never replaces a previous successful snapshot with zero counts.
    return structuredClone(await pending)
  }
}

export const getReleaseSummary = createReleaseService()
