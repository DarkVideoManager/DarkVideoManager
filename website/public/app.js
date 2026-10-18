const frame = document.querySelector('#program-demo')
let pendingMode = null
function navigateDemo(mode) {
  pendingMode = mode
  frame.contentWindow?.postMessage({ type: 'dvm-demo-navigation', mode }, location.origin)
  frame.focus({ preventScroll: true })
  const target = matchMedia('(max-width: 960px), (pointer: coarse)').matches
    ? frame
    : document.querySelector('#experience')
  target.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    block: 'start',
  })
}
document
  .querySelectorAll('[data-open-mode]')
  .forEach((button) =>
    button.addEventListener('click', () => navigateDemo(button.dataset.openMode)),
  )
window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.source !== frame.contentWindow ||
    event.data?.type !== 'dvm-demo-ready'
  )
    return
  if (pendingMode)
    frame.contentWindow.postMessage(
      { type: 'dvm-demo-navigation', mode: pendingMode },
      location.origin,
    )
})
document.querySelector('a[href="#privacy-details"]').addEventListener('click', () => {
  document.querySelector('#privacy-details').open = true
})
