import { describe, expect, it } from 'vitest'
import { folderLabel } from './folderLabel'

describe('library folder names', () => {
  it('names drive roots, UNC shares and ordinary folders', () => {
    expect(folderLabel('E:\\')).toBe('E: 드라이브')
    expect(folderLabel('D:/')).toBe('D: 드라이브')
    expect(folderLabel('\\\\server\\share\\')).toBe('share')
    expect(folderLabel('C:\\Videos\\')).toBe('Videos')
    expect(folderLabel('/')).toBe('/')
  })
})
