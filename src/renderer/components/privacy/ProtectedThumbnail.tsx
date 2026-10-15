import { useEffect, useRef, useState } from 'react'
import { usePrivacySettings } from './PrivacyBoundary'

export default function ProtectedThumbnail({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}) {
  const settings = usePrivacySettings()
  const container = useRef<HTMLDivElement>(null)
  const [reveal, setReveal] = useState(false)
  useEffect(() => {
    setReveal(false)
  }, [src, settings.data?.maskThumbnails, settings.data?.revealOnHover, settings.error])
  // Until preferences are known, never briefly expose a previously hidden thumbnail.
  const masked = Boolean(settings.error) || !settings.data || settings.data.maskThumbnails
  const canReveal = settings.data?.revealOnHover && !settings.error
  useEffect(() => {
    const card = container.current?.closest('button')
    const focus = () => {
      if (canReveal) setReveal(true)
    }
    const blur = () => setReveal(false)
    card?.addEventListener('focus', focus)
    card?.addEventListener('blur', blur)
    return () => {
      card?.removeEventListener('focus', focus)
      card?.removeEventListener('blur', blur)
    }
  }, [canReveal])
  return (
    <div
      ref={container}
      className="h-full w-full"
      onMouseEnter={() => {
        if (canReveal) setReveal(true)
      }}
      onMouseLeave={() => setReveal(false)}
      aria-label={masked ? '대체 썸네일' : undefined}
    >
      {!settings.error && (!masked || reveal) ? (
        <img src={src} alt={alt} className={className} />
      ) : (
        <div className="flex h-full items-center justify-center bg-zinc-800 text-sm text-zinc-400">
          썸네일 가림
        </div>
      )}
    </div>
  )
}
