import { useEffect, useRef, useState } from 'react'
import './keyboard-guide.css'

const shortcuts = [
  { key: 'w', label: '재생 / 일시정지', feedback: '재생 / 일시정지 요청' },
  { key: 'a', label: '1초 뒤로', feedback: '뒤로 이동' },
  { key: 's', label: '하이라이트 저장', feedback: '하이라이트 저장 요청' },
  { key: 'd', label: '1초 앞으로', feedback: '앞으로 이동' },
  { key: 'q', label: '이전 하이라이트', feedback: '이전 하이라이트 이동 요청' },
  { key: 'e', label: '다음 하이라이트', feedback: '다음 하이라이트 이동 요청' },
  { key: 'z', label: '이전 자막', feedback: '이전 자막 이동 요청' },
  { key: 'c', label: '다음 자막', feedback: '다음 자막 이동 요청' },
] as const

type ShortcutKey = (typeof shortcuts)[number]['key']

function pressShortcut(button: HTMLButtonElement, key: ShortcutKey) {
  button.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code: `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    }),
  )
  button.dispatchEvent(
    new KeyboardEvent('keyup', {
      key,
      code: `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    }),
  )
}

export default function KeyboardGuide() {
  const [activeKey, setActiveKey] = useState<ShortcutKey | null>(null)
  const [usedKeys, setUsedKeys] = useState<Set<ShortcutKey>>(() => new Set())
  const [feedback, setFeedback] = useState('')
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function onShortcut(event: Event) {
      const key = (event as CustomEvent<unknown>).detail
      const shortcut = shortcuts.find((item) => item.key === key)
      if (!shortcut) return
      setActiveKey(shortcut.key)
      setUsedKeys((previous) => new Set(previous).add(shortcut.key))
      setFeedback(`${shortcut.key.toUpperCase()} · ${shortcut.feedback}`)
      if (releaseTimer.current) clearTimeout(releaseTimer.current)
      releaseTimer.current = setTimeout(() => setActiveKey(null), 260)
    }
    window.addEventListener('dvm-demo-shortcut', onShortcut)
    return () => {
      window.removeEventListener('dvm-demo-shortcut', onShortcut)
      if (releaseTimer.current) clearTimeout(releaseTimer.current)
    }
  }, [])

  return (
    <section className="demo-keyboard-guide" aria-label="재생·하이라이트·자막 단축키">
      <div className="demo-keyboard-intro">
        <strong>
          {usedKeys.size > 0 ? '키보드로 장면을 찾고 저장하세요' : 'W부터 눌러보세요'}
        </strong>
        <p>키보드나 화면 버튼으로 조작하세요.</p>
      </div>
      <div className="demo-keyboard-cluster" aria-label="누를 수 있는 재생·탐색 키">
        {shortcuts.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`demo-keycap demo-keycap-${key}`}
            data-active={activeKey === key ? 'true' : undefined}
            data-used={usedKeys.has(key) ? 'true' : undefined}
            aria-label={`${key.toUpperCase()} · ${label}`}
            aria-keyshortcuts={key.toUpperCase()}
            title={`${key.toUpperCase()} · ${label}`}
            onClick={(event) => pressShortcut(event.currentTarget, key)}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="demo-keyboard-details">
        <dl>
          {shortcuts.map(({ key, label }) => (
            <div key={key}>
              <dt>{key.toUpperCase()}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <p className="demo-keyboard-feedback" role="status" aria-live="polite" aria-atomic="true">
          {feedback || 'Shift + A / D는 5초씩 이동합니다.'}
        </p>
      </div>
    </section>
  )
}
