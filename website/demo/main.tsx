import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createJSONStorage } from 'zustand/middleware'
import { demoApi, getDemoStorageError, resetDemoState } from './api'
import { DEMO_LIBRARY_ID, DEMO_STATS_NOTICE, demoLibrary } from './data'
import App from '../../src/renderer/App'
import { useLibraryStore } from '../../src/renderer/store/libraryStore'
import '../../src/renderer/styles/globals.css'
import './demo.css'
import KeyboardGuide from './KeyboardGuide'
import { initDemoWindowControls } from './window-controls'

window.api = demoApi
initDemoWindowControls()
const preferences = new Map<string, string>()
function showStorageNotice(message: string) {
  const notice = document.getElementById('demo-storage-notice')!
  notice.textContent = message
  notice.hidden = false
}
// A browser with blocked/full storage can still render and play the demo.
// This fallback is for view preferences only; content saves still report errors.
useLibraryStore.persist?.setOptions({
  storage: createJSONStorage(() => ({
    getItem(key: string) {
      try {
        return localStorage.getItem(key) ?? preferences.get(key) ?? null
      } catch {
        return preferences.get(key) ?? null
      }
    },
    setItem(key: string, value: string) {
      preferences.set(key, value)
      try {
        localStorage.setItem(key, value)
      } catch {
        showStorageNotice(
          '브라우저 저장소를 사용할 수 없어 화면 설정은 이번 방문에만 유지됩니다. 저장 기능은 제한될 수 있습니다.',
        )
      }
    },
    removeItem(key: string) {
      preferences.delete(key)
      try {
        localStorage.removeItem(key)
      } catch {
        showStorageNotice('브라우저 저장소에 있는 화면 설정을 초기화하지 못했습니다.')
      }
    },
  })),
})
const storageError = getDemoStorageError()
if (storageError) showStorageNotice(storageError)
useLibraryStore.getState().setActiveLibrary(demoLibrary)
useLibraryStore.setState({ openedLibraryId: null, selectedVideoId: null })
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 1000 } } })

function updateLayout() {
  document.body.dataset.page = location.hash.startsWith('#/player/')
    ? 'player'
    : location.hash.startsWith('#/stats')
      ? 'stats'
      : location.hash.startsWith('#/subtitles')
        ? 'subtitles'
        : 'library'
  document.body.dataset.selected = String(Boolean(useLibraryStore.getState().selectedVideoId))
  const notice = document.getElementById('demo-example-notice')!
  notice.textContent =
    document.body.dataset.page === 'stats'
      ? DEMO_STATS_NOTICE
      : '예시 데이터가 준비되어 있습니다 · 자막 생성은 수작업 예시 자막을 이용한 시뮬레이션입니다.'
}
updateLayout()
window.addEventListener('hashchange', updateLayout)
useLibraryStore.subscribe(updateLayout)

class DemoErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    if (this.state.error)
      return (
        <div className="demo-fatal">
          <h1>체험판을 불러오지 못했습니다.</h1>
          <p>{this.state.error}</p>
          <button onClick={() => location.reload()}>다시 불러오기</button>
        </div>
      )
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <DemoErrorBoundary>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </DemoErrorBoundary>,
)
ReactDOM.createRoot(document.getElementById('demo-keyboard-guide')!).render(<KeyboardGuide />)

const guide = document.querySelector<HTMLDialogElement>('#demo-guide')!
document.querySelector('#demo-more')!.addEventListener('click', (event) => {
  const button = event.currentTarget as HTMLButtonElement
  const expanded = button.getAttribute('aria-expanded') !== 'true'
  button.setAttribute('aria-expanded', String(expanded))
  button.textContent = expanded ? '접기' : '더보기'
  document.getElementById('demo-toolbar')!.dataset.expanded = String(expanded)
})
document.querySelector('#demo-toolbar')!.addEventListener(
  'click',
  (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest(
        '#demo-library, #demo-play, #demo-generation, #demo-stats, #demo-highlight, #demo-thumbnail',
      )
    )
      window.dispatchEvent(new Event('dvm-demo-open-window'))
  },
  true,
)
document.querySelector('#demo-help')!.addEventListener('click', () => guide.showModal())
document.querySelector('#close-guide')!.addEventListener('click', () => guide.close())
document.querySelector('#demo-library')!.addEventListener('click', () => {
  useLibraryStore.setState({ selectedVideoId: null })
  location.hash = '#/'
})
document.querySelector('#demo-generation')!.addEventListener('click', () => {
  location.hash = '#/subtitles'
})
document.querySelector('#demo-stats')!.addEventListener('click', () => {
  location.hash = '#/stats'
})
// Reuse the player's own shortcut handlers for the touch-friendly demo controls.
for (const [id, key] of [
  ['demo-highlight', 'h'],
  ['demo-thumbnail', 'f'],
]) {
  document.getElementById(id)!.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: `Key${key.toUpperCase()}`,
        bubbles: true,
        cancelable: true,
      }),
    )
    button.dispatchEvent(
      new KeyboardEvent('keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true }),
    )
  })
}
document.querySelector('#demo-play')!.addEventListener('click', () => {
  const videoId = useLibraryStore.getState().selectedVideoId || 'baseball-1'
  location.hash = `#/player/${DEMO_LIBRARY_ID}/${encodeURIComponent(videoId)}`
})
document.querySelector('#demo-reset')!.addEventListener('click', () => {
  if (
    !confirm(
      '이 브라우저 데모의 별점, 메모, 하이라이트, 썸네일, 자막 작업과 시청 기록을 예시 데이터가 있는 초기 상태로 되돌릴까요?',
    )
  )
    return
  const result = resetDemoState()
  if (!result.ok) {
    alert(result.error)
    return
  }
  try {
    localStorage.removeItem('dark-video-manager-library-store')
  } catch {
    alert(
      '장면 저장 데이터는 초기화했지만 화면 설정을 초기화하지 못했습니다. 브라우저 저장 권한을 확인해 주세요.',
    )
    return
  }
  location.hash = '#/'
  location.reload()
})

function openPlayerPanel(panel: 'subtitles' | 'highlights', videoId = 'baseball-1') {
  const target = `#/player/${DEMO_LIBRARY_ID}/${encodeURIComponent(videoId)}?panel=${panel}`
  if (location.hash !== target) location.hash = target
  else {
    const label = panel === 'subtitles' ? '자막 탐색' : '하이라이트'
    // A repeated landing-page action should reopen its tab even after a manual tab change.
    ;[...document.querySelectorAll<HTMLButtonElement>('#root aside button')]
      .find((button) => button.textContent?.trim() === label)
      ?.click()
  }
}
window.addEventListener('dvm-demo-route-change', updateLayout)

window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== window.parent ||
    event.data?.type !== 'dvm-demo-navigation'
  )
    return
  const mode = event.data.mode
  if (['library', 'subtitles', 'highlights', 'generation', 'stats', 'long-video'].includes(mode))
    window.dispatchEvent(new Event('dvm-demo-open-window'))
  if (mode === 'library') {
    useLibraryStore.setState({ selectedVideoId: null })
    location.hash = '#/'
  }
  if (mode === 'subtitles') openPlayerPanel('subtitles')
  if (mode === 'highlights') openPlayerPanel('highlights')
  if (mode === 'generation') location.hash = '#/subtitles'
  if (mode === 'stats') location.hash = '#/stats'
  if (mode === 'long-video') openPlayerPanel('subtitles', 'baseball-4')
  if (['subtitles', 'highlights', 'long-video'].includes(mode))
    document.getElementById('root')!.focus({ preventScroll: true })
})

window.parent.postMessage({ type: 'dvm-demo-ready' }, location.origin)
