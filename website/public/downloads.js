;(() => {
  const panel = document.querySelector('#downloads')
  if (!panel) return
  const status = panel.querySelector('[data-download-status]')
  const number = new Intl.NumberFormat('ko-KR')
  const refreshInterval = 10 * 60 * 1000
  let loading = false
  let hasResult = false
  let lastAttempt = 0

  const validCount = (value) => Number.isSafeInteger(value) && value >= 0
  function validUrl(value, prefix) {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return (
        url.origin === 'https://github.com' &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith(`/DarkVideoManager/DarkVideoManager/releases/${prefix}/`) &&
        !url.search &&
        !url.hash
      )
    } catch {
      return false
    }
  }

  function validate(data) {
    if (
      typeof data?.version !== 'string' ||
      data.version.length > 80 ||
      !validUrl(data.releaseUrl, 'tag') ||
      !Number.isFinite(Date.parse(data.checkedAt)) ||
      !validCount(data.totals?.setup) ||
      !validCount(data.totals?.portable) ||
      !validCount(data.totals?.total) ||
      data.totals.total !== data.totals.setup + data.totals.portable ||
      !data.downloads ||
      (!data.downloads.setup && !data.downloads.portable)
    )
      throw new Error('Invalid release')
    for (const kind of ['setup', 'portable']) {
      const asset = data.downloads[kind]
      if (
        asset !== null &&
        (!asset || !validCount(asset.count) || !validUrl(asset.url, 'download'))
      ) {
        throw new Error('Invalid asset')
      }
    }
  }

  async function refreshDownloads() {
    if (loading) return
    loading = true
    lastAttempt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch('/api/releases', {
        signal: controller.signal,
        credentials: 'omit',
      })
      if (!response.ok) throw new Error('Release unavailable')
      const data = await response.json()
      validate(data)
      panel.querySelector('[data-release-version]').textContent = data.version
      panel.querySelector('[data-download-total]').textContent = number.format(data.totals.total)
      for (const kind of ['setup', 'portable']) {
        const asset = data.downloads[kind]
        const option = panel.querySelector(`[data-download-option="${kind}"]`)
        option.hidden = !asset
        if (!asset) continue
        const link = option.querySelector('a')
        link.href = asset.url
        link.firstChild.textContent = kind === 'setup' ? '설치 파일 다운로드 ' : '포터블 다운로드 '
        option.querySelector('[data-download-count]').textContent =
          `이 버전 ${number.format(asset.count)}회`
      }
      document.querySelectorAll('[data-release-link]').forEach((link) => {
        link.href = data.releaseUrl
      })
      const checkedAt = new Intl.DateTimeFormat('ko-KR', {
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Seoul',
      }).format(new Date(data.checkedAt))
      panel.querySelector('[data-download-updated]').textContent =
        `${checkedAt} 집계 (한국 시간) · 주기적으로 자동 갱신`
      panel.querySelector('[data-download-details]').hidden = false
      status.textContent = ''
      status.hidden = true
      hasResult = true
      panel.dataset.state = 'ready'
    } catch {
      status.hidden = false
      status.textContent = hasResult
        ? '최신 집계를 불러오지 못했습니다. 마지막으로 확인한 정보를 표시합니다.'
        : '최신 정보를 불러오지 못했습니다. 아래 링크에서 GitHub의 최신 릴리스를 확인하세요.'
      panel.dataset.state = hasResult ? 'stale' : 'unavailable'
    } finally {
      clearTimeout(timeout)
      loading = false
    }
  }

  void refreshDownloads()
  setInterval(() => {
    if (!document.hidden) void refreshDownloads()
  }, refreshInterval)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastAttempt >= refreshInterval) void refreshDownloads()
  })
})()
