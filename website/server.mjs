import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import releases from './api/releases.js'

const root = fileURLToPath(new URL('./public/', import.meta.url))
const config = JSON.parse(await readFile(new URL('./vercel.json', import.meta.url), 'utf8'))
const securityHeaders = Object.fromEntries(
  config.headers[0].headers.map(({ key, value }) => [key, value]),
)
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    if (pathname === '/api/releases' || pathname === '/api/releases/') {
      for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value)
      return await releases(req, res)
    }
    if (!['GET', 'HEAD'].includes(req.method)) return res.writeHead(405).end()
    let file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(403).end()
      return
    }
    let info = await stat(file)
    if (info.isDirectory()) {
      file = resolve(file, 'index.html')
      info = await stat(file)
    }
    const headers = {
      ...securityHeaders,
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    }
    let start = 0,
      end = info.size - 1,
      status = 200
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end
      }
      if (!match || (!match[1] && !match[2]) || start > end || start >= info.size) {
        return res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end()
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`
    }
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 })
    if (req.method === 'HEAD') return res.end()
    const stream = createReadStream(file, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch {
    res.writeHead(404).end('Not found')
  }
})
const port = Number(process.env.DVM_WEBSITE_PORT || 4178)
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`))
