import './window-controls.css'

type WindowState = 'open' | 'minimized' | 'closed'
type WindowSize = 'expanded' | 'restored'

const restoreIcon =
  '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z" /></svg>'
const maximizeIcon =
  '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5h9v9h-9z" /></svg>'

/** Fit the desktop-style window controls to the browser without unmounting the app. */
export function initDemoWindowControls(): void {
  const frame = document.getElementById('demo-window')
  const controls = document.getElementById('demo-window-controls')
  const surface = document.getElementById('demo-window-surface')
  if (!frame || !controls || !surface || controls.dataset.initialized === 'true') return
  controls.dataset.initialized = 'true'
  controls.innerHTML = `
    <div class="demo-window-title">
      <img src="/assets/app-icon.ico" width="16" height="16" alt="" />
      <span>DarkVideoManager</span>
    </div>
    <div class="demo-window-actions" role="group" aria-label="창 제어">
      <button type="button" id="demo-window-minimize" aria-label="최소화" title="최소화">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
      </button>
      <button type="button" id="demo-window-size" aria-label="이전 크기로" title="이전 크기로">${restoreIcon}</button>
      <button type="button" id="demo-window-close" aria-label="닫기" title="닫기">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m.5.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>`

  const status = document.createElement('div')
  status.id = 'demo-window-status'
  status.hidden = true
  status.innerHTML =
    '<p role="status" aria-live="polite"></p><button type="button" id="demo-window-reopen">창 복원</button>'
  controls.insertAdjacentElement('afterend', status)

  const minimizeButton = controls.querySelector<HTMLButtonElement>('#demo-window-minimize')!
  const sizeButton = controls.querySelector<HTMLButtonElement>('#demo-window-size')!
  const closeButton = controls.querySelector<HTMLButtonElement>('#demo-window-close')!
  const reopenButton = status.querySelector<HTMLButtonElement>('#demo-window-reopen')!
  const statusText = status.querySelector<HTMLParagraphElement>('p')!
  let state: WindowState = 'open'
  let size: WindowSize = 'expanded'

  function refresh() {
    document.body.dataset.demoWindow = state
    frame!.dataset.windowSize = size
    surface!.hidden = state !== 'open'
    surface!.inert = state !== 'open'
    status.hidden = state === 'open'
    minimizeButton.disabled = state !== 'open'
    sizeButton.disabled = state !== 'open'
    closeButton.disabled = state === 'closed'
    const sizeLabel = size === 'expanded' ? '이전 크기로' : '최대화'
    sizeButton.setAttribute('aria-label', sizeLabel)
    sizeButton.title = sizeLabel
    sizeButton.innerHTML = size === 'expanded' ? restoreIcon : maximizeIcon
    statusText.textContent =
      state === 'minimized'
        ? '체험 창이 최소화되었습니다.'
        : state === 'closed'
          ? '체험 창을 닫았습니다.'
          : ''
    reopenButton.textContent = state === 'closed' ? '다시 열기' : '창 복원'
  }

  function hideWindow(nextState: 'minimized' | 'closed') {
    state = nextState
    // Blur also releases held seek keys before the hidden player can receive more input.
    window.dispatchEvent(new Event('blur'))
    surface!.querySelectorAll('video').forEach((video) => video.pause())
    refresh()
    reopenButton.focus({ preventScroll: true })
  }

  function openWindow() {
    if (state === 'open') return
    state = 'open'
    refresh()
    document.getElementById('root')?.focus({ preventScroll: true })
  }

  function toggleSize() {
    if (state !== 'open') return
    size = size === 'expanded' ? 'restored' : 'expanded'
    refresh()
  }

  minimizeButton.addEventListener('click', () => hideWindow('minimized'))
  sizeButton.addEventListener('click', toggleSize)
  closeButton.addEventListener('click', () => hideWindow('closed'))
  reopenButton.addEventListener('click', openWindow)
  controls.addEventListener('dblclick', (event) => {
    if ((event.target as Element).closest('button')) return
    toggleSize()
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (state === 'open' || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Escape' || /^Key[A-Z]$/.test(event.code) || /^[a-z]$/i.test(event.key)) {
        // Keep hidden page-level shortcuts quiet without cancelling native button/navigation keys.
        event.stopImmediatePropagation()
      }
    },
    true,
  )
  surface.addEventListener(
    'play',
    (event) => {
      if (state !== 'open' && event.target instanceof HTMLVideoElement) event.target.pause()
    },
    true,
  )
  window.addEventListener('dvm-demo-open-window', openWindow)
  refresh()
}
