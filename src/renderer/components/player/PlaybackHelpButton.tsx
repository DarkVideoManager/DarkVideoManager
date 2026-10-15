import { useEffect, useRef, useState } from 'react'

const shortcuts = [
  ['Space / P', '재생 / 일시정지'],
  ['A / D 또는 ← / →', '이전 / 다음으로 1초 이동'],
  ['Shift + 이동 키', '5초씩 이동'],
  ['Ctrl + 이동 키', '30초씩 이동'],
  ['↑ / ↓', '음량 5% 올리기 / 내리기'],
  ['Q / E', '이전 / 다음 하이라이트로 이동'],
  ['H', '현재 위치에 하이라이트 추가'],
  ['S', '현재 위치의 하이라이트 저장'],
  ['F / T', '현재 화면을 대표 썸네일로 지정'],
  ['Z / C', '이전 / 다음 자막으로 이동'],
  ['O', '설정된 외부 플레이어로 열기'],
  ['Esc', '재생 화면에서 라이브러리로 돌아가기'],
]

function PlaybackHelpDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => {
      dialog?.close()
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="playback-help-title"
      className="m-auto max-h-[90vh] w-[min(40rem,calc(100vw-2rem))] max-w-none overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 text-zinc-100 shadow-2xl backdrop:bg-black/70"
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault()
          event.currentTarget.querySelector('button')?.focus()
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="playback-help-title" className="text-lg font-semibold">
          단축키·재생 조작 안내
        </h2>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="rounded bg-zinc-700 px-3 py-2 text-sm hover:bg-zinc-600"
        >
          닫기
        </button>
      </div>
      <div className="space-y-4 text-sm leading-relaxed">
        <section aria-label="왼손 조작">
          <h3 className="font-semibold text-indigo-200">왼손 조작</h3>
          <p className="mt-1 text-zinc-300">
            별도 모드 전환 없이 A/D로 이동하고 Q/E로 하이라이트, Z/C로 자막을 넘길 수 있습니다. 이동
            키를 길게 누르면 연속 이동하며 점차 빨라집니다.
          </p>
        </section>
        <table className="w-full text-left text-xs sm:text-sm">
          <caption className="mb-2 text-left text-zinc-400">
            인앱 플레이어 단축키 · 입력란에서 글을 쓰거나 대화상자를 연 동안에는 실행되지 않습니다.
          </caption>
          <thead>
            <tr className="border-b border-zinc-700">
              <th scope="col" className="py-2 pr-3">
                키
              </th>
              <th scope="col" className="py-2">
                동작
              </th>
            </tr>
          </thead>
          <tbody>
            {shortcuts.map(([keys, action]) => (
              <tr key={keys} className="border-b border-zinc-800">
                <td className="py-2 pr-3 font-mono text-indigo-200">{keys}</td>
                <td className="py-2 text-zinc-300">{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section aria-label="음량과 화면 크기">
          <h3 className="font-semibold text-indigo-200">음량과 화면 크기</h3>
          <p className="mt-1 text-zinc-300">
            음량은 ↑/↓ 키로 조절하며 다음 영상에도 유지됩니다. 재생 화면 왼쪽 위의 플레이어 최대화를
            누르면 상세 패널을 숨겨 영상을 넓게 볼 수 있고, 상세 보기로 되돌릴 수 있습니다. 앱 창은
            창 가장자리를 드래그하거나 제목 표시줄의 최대화 버튼으로 크기를 바꿉니다.
          </p>
          <p className="mt-2 text-zinc-400">
            인앱 전체 화면 전환과 자유로운 키 재지정 설정은 현재 제공하지 않습니다. F 키는 썸네일
            지정입니다. 외부 플레이어의 전체 화면 조작은 해당 플레이어에서 확인하세요. 앱과 연결된
            mpv에서도 F 키를 썸네일 지정으로 사용합니다.
          </p>
        </section>
        <section aria-label="관련 설정 위치">
          <h3 className="font-semibold text-indigo-200">관련 설정 위치</h3>
          <p className="mt-1 text-zinc-300">
            라이브러리 상단의 설정 → 외부 플레이어에서 mpv, ffplay 또는 VLC를 선택할 수 있습니다. 이
            안내는 상단 조작 안내와 재생 화면에서도 다시 열 수 있습니다.
          </p>
        </section>
      </div>
    </dialog>
  )
}

export default function PlaybackHelpButton({
  label = '조작 안내',
  className = 'rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800',
}: {
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={className}
      >
        {label}
      </button>
      {open && <PlaybackHelpDialog onClose={() => setOpen(false)} />}
    </>
  )
}
