import * as React from 'react'

export function usePlayerView(
  containerRef: React.RefObject<HTMLDivElement | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  videoId: string,
  onError: (error: string | null) => void,
  onFullscreenChange?: (active: boolean, explicit: boolean) => void,
) {
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [zoom, setZoom] = React.useState(1)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [showInfo, setShowInfo] = React.useState(false)
  const drag = React.useRef<{
    id: number
    x: number
    y: number
    pan: { x: number; y: number }
  } | null>(null)
  const moved = React.useRef(false)
  const explicitExit = React.useRef(false)
  const resetZoom = React.useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    drag.current = null
  }, [])
  React.useEffect(() => {
    resetZoom()
    setShowInfo(false)
  }, [videoId, resetZoom])
  const exitFullscreen = React.useCallback(async () => {
    if (document.fullscreenElement !== containerRef.current) return
    explicitExit.current = true
    try {
      await document.exitFullscreen()
    } catch (error) {
      explicitExit.current = false
      onError(
        `전체화면을 해제하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [containerRef, onError])
  React.useEffect(() => {
    if (!enabled) {
      resetZoom()
      void exitFullscreen()
    }
  }, [enabled, resetZoom, exitFullscreen])
  React.useEffect(() => {
    const sync = () => {
      const active = document.fullscreenElement === containerRef.current
      setIsFullscreen(active)
      onFullscreenChange?.(active, explicitExit.current)
      explicitExit.current = false
      setPan({ x: 0, y: 0 })
    }
    document.addEventListener('fullscreenchange', sync)
    setIsFullscreen(document.fullscreenElement === containerRef.current)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [containerRef, onFullscreenChange])
  React.useEffect(() => {
    const stage = videoRef.current?.parentElement
    if (!stage) return
    const observer = new ResizeObserver(() => setPan({ x: 0, y: 0 }))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [videoRef])
  const toggleFullscreen = React.useCallback(async () => {
    if (!enabled && document.fullscreenElement !== containerRef.current) return
    onError(null)
    try {
      if (document.fullscreenElement === containerRef.current) {
        await exitFullscreen()
      } else {
        if (!containerRef.current?.requestFullscreen)
          throw new Error('전체화면을 지원하지 않습니다.')
        await containerRef.current.requestFullscreen()
      }
    } catch (error) {
      onError(
        `전체화면을 전환하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }, [containerRef, enabled, onError, exitFullscreen])
  const changeZoom = React.useCallback(
    (delta: number) => {
      if (!enabled) return
      setZoom((value) => Math.min(4, Math.max(1, Math.round((value + delta) * 100) / 100)))
      setPan({ x: 0, y: 0 })
    },
    [enabled],
  )
  const handleKey = React.useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.fullscreenElement === containerRef.current) {
        if (!event.repeat) void exitFullscreen()
      } else if (
        event.key === 'Enter' &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (enabled || isFullscreen)
      ) {
        if (!event.repeat) void toggleFullscreen()
      } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        if (event.key.toLowerCase() === 'i') {
          if (!event.repeat) setShowInfo((value) => !value)
        } else if (enabled && ['+', '='].includes(event.key)) changeZoom(0.25)
        else if (enabled && event.key === '-') changeZoom(-0.25)
        else return false
      } else return false
      event.preventDefault()
      event.stopPropagation()
      return true
    },
    [changeZoom, enabled, toggleFullscreen, containerRef, exitFullscreen, isFullscreen],
  )
  const pointer = {
    onPointerDown(event: React.PointerEvent<HTMLVideoElement>) {
      moved.current = false
      if (!enabled || zoom <= 1 || event.button !== 0) return
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pan }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove(event: React.PointerEvent<HTMLVideoElement>) {
      const start = drag.current
      if (!start || start.id !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
      const media = videoRef.current
      const width = media?.videoWidth || bounds.width
      const height = media?.videoHeight || bounds.height
      const fit = Math.min(bounds.width / width, bounds.height / height)
      const limitX = Math.max(0, (width * fit * zoom - bounds.width) / 2)
      const limitY = Math.max(0, (height * fit * zoom - bounds.height) / 2)
      setPan({
        x: Math.max(-limitX, Math.min(limitX, start.pan.x + dx)),
        y: Math.max(-limitY, Math.min(limitY, start.pan.y + dy)),
      })
    },
    onPointerUp() {
      drag.current = null
    },
    onPointerCancel() {
      drag.current = null
      moved.current = true
    },
    onLostPointerCapture() {
      drag.current = null
    },
  }
  return {
    isFullscreen,
    zoom,
    showInfo,
    setShowInfo,
    resetZoom,
    changeZoom,
    toggleFullscreen,
    handleKey,
    pointer,
    videoStyle: {
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      cursor: zoom > 1 ? 'grab' : undefined,
      touchAction: zoom > 1 ? 'none' : undefined,
    },
    consumeDrag() {
      const didMove = moved.current
      moved.current = false
      return didMove
    },
  }
}
