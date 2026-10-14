const playerShortcuts = new Set(['w', 'a', 's', 'd', 'q', 'e', 'z', 'c'])

// Physical keys also work when a Korean keyboard layout is selected.
export function browserPlayerKey(event: KeyboardEvent): string {
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key.toLowerCase()
}

export function ignoreBrowserPlayerKey(
  event: KeyboardEvent,
  subtitleNavigationTarget: HTMLElement | null,
): boolean {
  const key = browserPlayerKey(event)
  const target = event.target instanceof Element ? event.target : null
  if (
    ['minimized', 'closed'].includes(document.body.dataset.demoWindow ?? '') ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') ||
    target?.closest(
      'input:not([type="range"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    )
  )
    return true
  // Keep native button activation and subtitle-list navigation accessible.
  if ((key === ' ' || key === 'spacebar') && target?.closest('button, [role="button"]')) return true
  if (subtitleNavigationTarget?.contains(target) && !playerShortcuts.has(key)) return true
  // A held key must not toggle playback repeatedly or queue duplicate captures.
  return (
    event.repeat && !['a', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)
  )
}

export function announceBrowserPlayerKey(event: KeyboardEvent): void {
  const key = browserPlayerKey(event)
  if (playerShortcuts.has(key) && !event.repeat)
    window.dispatchEvent(new CustomEvent('dvm-demo-shortcut', { detail: key }))
}
