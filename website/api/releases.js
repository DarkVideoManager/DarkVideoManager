import { getReleaseSummary } from '../lib/releases.js'

export function createReleasesHandler(getSummary = getReleaseSummary) {
  return async function releases(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD')
      res.statusCode = 405
      return res.end(JSON.stringify({ error: '지원하지 않는 요청입니다.' }))
    }
    try {
      const summary = await getSummary()
      res.statusCode = 200
      res.setHeader('Cache-Control', 'public, max-age=60')
      res.setHeader('Vercel-CDN-Cache-Control', 'public,s-maxage=600,stale-while-revalidate=3600')
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(summary))
    } catch {
      res.statusCode = 503
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ error: '다운로드 정보를 잠시 불러올 수 없습니다.' }),
      )
    }
  }
}

export default createReleasesHandler()
