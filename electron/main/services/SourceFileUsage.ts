import { resolve } from 'node:path'

const users = new Map<string, number>()
const key = (filePath: string) => resolve(filePath).toLowerCase()

/** Keep paused playback and pending native launches protected until their owner releases them. */
export function acquireSourceFile(filePath: string): () => void {
  const path = key(filePath)
  users.set(path, (users.get(path) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (users.get(path) ?? 1) - 1
    if (remaining) users.set(path, remaining)
    else users.delete(path)
  }
}

export function isSourceFileInUse(filePath: string): boolean {
  return users.has(key(filePath))
}
