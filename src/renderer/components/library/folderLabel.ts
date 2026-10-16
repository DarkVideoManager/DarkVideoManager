/** Directory names for library titles, including drive roots and UNC shares. */
export function folderLabel(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed} 드라이브`
  return trimmed.split(/[\\/]/).pop() || folder || '새 라이브러리'
}
