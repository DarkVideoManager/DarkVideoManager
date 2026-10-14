// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.

function toLocalMediaUrl(filePath: string, version?: string | number): string {
  const versionQuery = version == null ? '' : `&v=${encodeURIComponent(String(version))}`
  return `local-media://file?path=${encodeURIComponent(filePath)}${versionQuery}`
}

export { toLocalMediaUrl }
