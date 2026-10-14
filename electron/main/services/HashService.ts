import { createHash } from 'crypto'
import { createReadStream, statSync } from 'fs'
import type { Hash } from 'crypto'

const HEAD_BYTES = 64 * 1024 * 1024 // 64MB

function readChunk(hash: Hash, filePath: string, start: number, end: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start, end: end - 1 })
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
}

/**
 * 앞 64MB + 뒤 64MB + fileSize 기반 SHA-256 (첫 16자)
 */
export async function computeHash(filePath: string): Promise<string> {
  const { size } = statSync(filePath)
  const hash = createHash('sha256')
  hash.update(String(size))

  const headEnd = Math.min(HEAD_BYTES, size)
  await readChunk(hash, filePath, 0, headEnd)

  if (size > HEAD_BYTES * 2) {
    await readChunk(hash, filePath, size - HEAD_BYTES, size)
  }

  return hash.digest('hex').slice(0, 16)
}
