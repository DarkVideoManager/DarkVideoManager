import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { acquireSourceFile, isSourceFileInUse } from './SourceFileUsage'

it('keeps a source protected until every playback owner releases it, with idempotent release', () => {
  const file = resolve('source-usage-test.mp4')
  const first = acquireSourceFile(file)
  const second = acquireSourceFile(file.toUpperCase())
  expect(isSourceFileInUse(file)).toBe(true)
  first()
  first()
  expect(isSourceFileInUse(file)).toBe(true)
  second()
  expect(isSourceFileInUse(file)).toBe(false)
})
