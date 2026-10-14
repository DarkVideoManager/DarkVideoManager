// FFprobe codec names that Chromium's built-in video element cannot decode.
const incompatibleVideoCodecs = new Set([
  'mpeg4',
  'mpeg1video',
  'mpeg2video',
  'msmpeg4v1',
  'msmpeg4v2',
  'msmpeg4v3',
  'wmv1',
  'wmv2',
  'wmv3',
  'vc1',
  'flv1',
])

export function needsVideoTranscode(codec?: string): boolean {
  return incompatibleVideoCodecs.has(codec?.trim().toLowerCase() ?? '')
}

export function needsCompatiblePlayback(filePath: string, codec?: string): boolean {
  return /\.avi$/i.test(filePath) || needsVideoTranscode(codec)
}
