// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import VideoCard$1 from './VideoCard'
const MIN_CARD_WIDTH = 260
const CARD_HEIGHT = 440
const GRID_GAP = 16
const GRID_PADDING = 16
const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP
const EMPTY_SUBTITLE_JOBS = new Map()
function VideoGrid({
  videos,
  subtitleJobs = EMPTY_SUBTITLE_JOBS,
  selectedVideoId,
  initialScrollTop = 0,
  onScrollTopChange,
  onVideoClick,
  onVideoDoubleClick,
}) {
  const containerRef = React.useRef(null)
  const restoredScrollTopRef = React.useRef(null)
  const [containerWidth, setContainerWidth] = React.useState(0)
  React.useEffect(() => {
    restoredScrollTopRef.current = null
  }, [])
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateWidth = () => setContainerWidth(container.clientWidth)
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(container)
    return () => observer.disconnect()
  }, [videos.length === 0])
  const columnCount = React.useMemo(() => {
    const availableWidth = Math.max(0, containerWidth - GRID_PADDING * 2)
    if (availableWidth <= 0) return 1
    return Math.max(1, Math.floor((availableWidth + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)))
  }, [containerWidth])
  const itemWidth = React.useMemo(() => {
    const availableWidth = Math.max(0, containerWidth - GRID_PADDING * 2)
    if (availableWidth <= 0) return MIN_CARD_WIDTH
    return (availableWidth - GRID_GAP * (columnCount - 1)) / columnCount
  }, [columnCount, containerWidth])
  const rowCount = Math.ceil(videos.length / columnCount)
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 4,
  })
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (restoredScrollTopRef.current === initialScrollTop) return
    const restore = () => {
      container.scrollTop = initialScrollTop
      restoredScrollTopRef.current = initialScrollTop
    }
    restore()
    const frame = requestAnimationFrame(restore)
    return () => cancelAnimationFrame(frame)
  }, [initialScrollTop, rowCount, selectedVideoId])
  if (videos.length === 0) {
    return (
      <div className={'flex flex-1 items-center justify-center text-zinc-500'}>
        <p>{'동영상이 없습니다. 폴더를 가져오거나 검색 조건을 변경하세요.'}</p>
      </div>
    )
  }
  const virtualRows = rowVirtualizer.getVirtualItems()
  const totalHeight = rowVirtualizer.getTotalSize() + GRID_PADDING * 2
  return (
    <div
      ref={containerRef}
      className={'flex-1 overflow-y-auto'}
      onScroll={(event) => onScrollTopChange?.(event.currentTarget.scrollTop)}
    >
      <div
        className={'relative'}
        style={{
          height: totalHeight,
        }}
      >
        {virtualRows.map((virtualRow) => {
          const rowIndex = virtualRow.index
          const rowTop = virtualRow.start + GRID_PADDING
          return (
            <div
              className={'absolute left-0 right-0'}
              style={{
                top: rowTop,
                height: CARD_HEIGHT,
              }}
              key={virtualRow.key}
            >
              {Array.from(
                {
                  length: columnCount,
                },
                (_, columnIndex) => {
                  const videoIndex = rowIndex * columnCount + columnIndex
                  const video = videos[videoIndex]
                  if (!video) return null
                  const left = GRID_PADDING + columnIndex * (itemWidth + GRID_GAP)
                  return (
                    <div
                      className={'absolute top-0'}
                      style={{
                        left,
                        width: itemWidth,
                        height: CARD_HEIGHT,
                      }}
                      key={video.id}
                    >
                      <VideoCard$1
                        video={video}
                        subtitleJob={subtitleJobs.get(video.id)}
                        isSelected={selectedVideoId === video.id}
                        onClick={() => onVideoClick?.(video)}
                        onDoubleClick={() => onVideoDoubleClick?.(video)}
                      />
                    </div>
                  )
                },
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
export default VideoGrid
