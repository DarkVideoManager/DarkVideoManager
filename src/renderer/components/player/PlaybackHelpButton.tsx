import { useEffect, useRef, useState } from 'react'

const shortcuts = [
  ['Space / P', '재생 / 일시정지'],
  ['A / D 또는 ← / →', '설정한 간격만큼 이전 / 다음으로 이동 (기본 1초)'],
  ['Shift + 이동 키', '5초씩 이동'],
  ['Ctrl + 이동 키', '30초씩 이동'],
  ['0–9', '영상의 0–90% 위치로 이동 (숫자패드는 NumLock 켜기)'],
  ['Alt + Enter', '전체화면 전환'],
  ['+ / -', '영상 확대 / 축소 (100–400%)'],
  ['I', '재생 정보 표시 / 숨기기'],
  ['↑ / ↓', '음량 5% 올리기 / 내리기'],
  ['Q / E', '이전 / 다음 하이라이트로 이동'],
  ['H', '현재 위치에 하이라이트 추가'],
  ['S', '현재 위치의 하이라이트 저장'],
  ['F / T', '현재 화면을 대표 썸네일로 지정'],
  ['Z / C', '이전 / 다음 자막으로 이동'],
  ['O', '설정된 외부 플레이어로 열기'],
  ['Esc', '전체화면 해제 · 일반 재생 화면에서는 라이브러리로 돌아가기'],
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
        <p>
          플레이어 위쪽 배속 메뉴에서 인앱·mpv의 속도를 0.25–4배로 바꾸고 1배속으로 복귀할 수
          있습니다. 음성과 자막도 영상 시간에 맞춰 재생됩니다. VLC는 자체 재생 → 속도 메뉴를
          사용하며 FFplay 배속은 앱에서 지원하지 않습니다.
        </p>
        <section aria-label="왼손 조작">
          <h3 className="font-semibold text-indigo-200">왼손 조작</h3>
          <p className="mt-1 text-zinc-300">
            별도 모드 전환 없이 A/D로 이동하고 Q/E로 하이라이트, Z/C로 자막을 넘길 수 있습니다. 이동
            키를 길게 누르면 연속 이동하며 점차 빨라집니다.
          </p>
          <p className="mt-2 text-zinc-400">
            숫자 키는 재생·일시정지 상태를 유지하며 이동합니다. 영상 길이를 알 수 없으면 동작하지
            않고, Shift·Ctrl·Alt와 함께 누른 숫자는 구간 이동에 사용하지 않습니다.
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
            음량은 ↑/↓ 키로 조절하며 다음 영상에도 유지됩니다. 전체화면 버튼이나 Alt+Enter로
            전체화면을 전환하고 Esc로 해제합니다. +/− 버튼·키로 영상을 확대·축소하고, 확대된 영상은
            드래그하여 위치를 옮깁니다. 화면 맞춤은 배율과 위치를 초기화합니다.
          </p>
          <p className="mt-2 text-zinc-400">
            플레이어 최대화는 상세 패널을 숨기며 상세 보기로 되돌립니다. 전체화면·확대는 인앱
            재생에서 지원합니다. 재생 정보 버튼 또는 I로 영상 정보를 표시하며, Tab은 버튼 사이의
            초점 이동을 유지합니다. F/T는 썸네일 지정이며 자유로운 키 재지정 설정은 제공하지
            않습니다.
          </p>
        </section>
        <section aria-label="관련 설정 위치">
          <h3 className="font-semibold text-indigo-200">관련 설정 위치</h3>
          <p className="mt-1 text-zinc-300">
            설정 → 재생 탐색 → 기본 탐색 간격 (초)에서 1–600초의 정수를 저장합니다. Shift 5초·Ctrl
            30초는 유지됩니다. 앱에서 여는 mpv에도 다음 실행부터 간격이 적용되며 숫자 구간 이동과 F
            키 썸네일 지정을 지원합니다. VLC·ffplay의 이동 간격과 외부 플레이어의 화면 조작은 해당
            플레이어 설정을 따릅니다. 설정 → 외부 플레이어에서 플레이어를 선택할 수 있습니다.
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
