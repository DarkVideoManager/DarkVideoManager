import type { VideoMetadataOptions } from './types'

export function normalizeVideoCategory(value?: string): string {
  return (value ?? '').trim().normalize('NFC')
}

export function normalizeVideoTag(value: string): string {
  return value
    .trim()
    .replace(/^#+\s*/, '')
    .trim()
    .normalize('NFC')
}

function uniqueTags(values: string[]): string[] {
  const tags = new Map<string, string>()
  for (const value of values) {
    const tag = normalizeVideoTag(value)
    const key = tag.toLowerCase()
    if (tag && !tags.has(key)) tags.set(key, tag)
  }
  return [...tags.values()]
}

export function parseVideoTags(value?: string): string[] {
  // Preserve comma-separated multiword tags; also accept "#one #two" input.
  const parts = (value ?? '').split(/[,\r\n]+/).flatMap((part) => {
    const trimmed = part.trim()
    return trimmed.startsWith('#') ? trimmed.split(/\s+(?=#)/) : [trimmed]
  })
  return uniqueTags(parts)
}

export function serializeVideoTags(value?: string): string {
  return parseVideoTags(value).join(', ')
}

export function hasVideoTag(value: string | undefined, requestedTag: string): boolean {
  const key = normalizeVideoTag(requestedTag).toLowerCase()
  return Boolean(key) && parseVideoTags(value).some((tag) => tag.toLowerCase() === key)
}

export function parseVideoSearch(value?: string): { text: string; tags: string[] } {
  const tags: string[] = []
  const text = (value ?? '').replace(/(^|\s)#([^\s,]+)/g, (_match, prefix: string, tag: string) => {
    tags.push(tag)
    return prefix
  })
  return {
    text: (tags.length ? text.replace(/\s+/g, ' ') : text).trim(),
    tags: uniqueTags(tags),
  }
}

export function collectVideoMetadataOptions(
  videos: Iterable<{ category?: string; tags?: string }>,
): VideoMetadataOptions {
  const categories = new Set<string>()
  const tags: string[] = []
  for (const video of videos) {
    const category = normalizeVideoCategory(video.category)
    if (category) categories.add(category)
    tags.push(...parseVideoTags(video.tags))
  }
  const compare = (left: string, right: string): number => left.localeCompare(right, 'ko')
  return {
    categories: [...categories].sort(compare),
    tags: uniqueTags(tags).sort(compare),
  }
}
