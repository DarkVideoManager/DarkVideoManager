/** Keep the production renderer unchanged; this build only reads demo-owned media. */
export function toLocalMediaUrl(filePath: string): string {
  if (filePath.startsWith('data:image/') || filePath.startsWith(`blob:${location.origin}/`)) return filePath
  if (filePath.startsWith('/demo-media/')) return filePath
  throw new Error('이 브라우저 체험판에서는 포함된 샘플 미디어만 사용할 수 있습니다.')
}
