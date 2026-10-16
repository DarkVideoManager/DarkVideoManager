import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Thumbnail } from '@shared/types'
import { thumbnailsApi } from '../../api'
import { toLocalMediaUrl } from '../../utils/media'

export default function ThumbnailSelector({
  libraryId,
  videoId,
  thumbnails,
  disabled,
}: {
  libraryId: string
  videoId: string
  thumbnails: Thumbnail[]
  disabled: boolean
}) {
  const queryClient = useQueryClient()
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set())
  const selection = useMutation({
    mutationFn: async (thumbnailId: string) => {
      const result = await thumbnailsApi.setPrimary(libraryId, thumbnailId, videoId)
      if (!result.ok) throw new Error(result.error)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thumbnails', libraryId, videoId] }),
        queryClient.invalidateQueries({ queryKey: ['video', libraryId, videoId] }),
        queryClient.invalidateQueries({ queryKey: ['videos', libraryId] }),
      ])
    },
  })
  return (
    <section aria-label="대표 썸네일 선택" className="space-y-2 rounded border border-zinc-700 p-3">
      <h3 className="text-xs font-semibold text-zinc-200">
        대표 썸네일 선택 · 후보 {thumbnails.length}개
      </h3>
      <p className="text-xs leading-relaxed text-zinc-400">
        후보를 누르면 카드와 상세 화면의 대표 이미지로 저장됩니다. 앱을 다시 열어도 유지됩니다. 자동
        생성은 최대 5개이며 영상에 따라 더 적을 수 있습니다. 직접 캡처한 장면도 표시합니다. 다시
        생성은 기존 후보를 새로 만들고 대표 선택도 초기화합니다.
      </p>
      {thumbnails.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {thumbnails.map((thumbnail, index) => (
            <button
              key={thumbnail.id}
              type="button"
              aria-label={`후보 ${index + 1} 대표 썸네일로 선택`}
              aria-pressed={thumbnail.isPrimary}
              disabled={disabled || selection.isPending || failedImages.has(thumbnail.id)}
              onClick={() => selection.mutate(thumbnail.id)}
              className={`overflow-hidden rounded border text-left text-xs disabled:opacity-50 ${thumbnail.isPrimary ? 'border-indigo-400' : 'border-zinc-700 hover:border-zinc-400'}`}
            >
              {failedImages.has(thumbnail.id) ? (
                <span className="flex aspect-video items-center justify-center p-2">
                  이미지 파일을 읽지 못했습니다
                </span>
              ) : (
                <img
                  src={toLocalMediaUrl(thumbnail.filePath, thumbnail.id)}
                  alt={`썸네일 후보 ${index + 1}`}
                  className="aspect-video w-full object-cover"
                  onError={() => setFailedImages((current) => new Set(current).add(thumbnail.id))}
                />
              )}
              <span className="block px-2 py-1 text-zinc-200">
                {thumbnail.isPrimary ? '현재 대표 · ' : ''}
                {Math.floor(thumbnail.timeSec / 60)}:
                {String(Math.floor(thumbnail.timeSec % 60)).padStart(2, '0')}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-amber-200">
          생성된 후보가 없습니다. 아래 다시 생성으로 후보를 만들어 주세요.
        </p>
      )}
      {thumbnails.some((thumbnail) => failedImages.has(thumbnail.id)) && (
        <p className="text-xs text-amber-200">
          읽을 수 없는 후보는 선택할 수 없습니다. 원본 영상 위치를 확인한 뒤 다시 생성해 주세요.
        </p>
      )}
      {selection.isPending && (
        <p role="status" className="text-xs text-zinc-300">
          대표 썸네일을 저장하고 있습니다.
        </p>
      )}
      {selection.isSuccess && (
        <p role="status" className="text-xs text-green-300">
          대표 썸네일을 저장했습니다.
        </p>
      )}
      {selection.isError && (
        <p role="alert" className="text-xs text-red-300">
          대표 썸네일을 저장하지 못했습니다: {selection.error.message} 현재 선택은 유지됩니다. 다시
          선택해 주세요.
        </p>
      )}
    </section>
  )
}
