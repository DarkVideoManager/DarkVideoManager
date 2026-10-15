import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeVideoCategory, serializeVideoTags } from '@shared/videoMetadata'
import { useVideoMetadataOptions } from '../../api/useVideos'

function createDraft(category, tags) {
  return {
    category,
    tags,
    savedCategory: category,
    savedTags: tags,
    observedCategory: category,
    observedTags: tags,
    pending: false,
    error: null,
    saved: false,
  }
}

function categoryChanged(draft) {
  return normalizeVideoCategory(draft.category) !== normalizeVideoCategory(draft.savedCategory)
}

function tagsChanged(draft) {
  return serializeVideoTags(draft.tags) !== serializeVideoTags(draft.savedTags)
}

export default function VideoMetadataEditor({ video, libraryId, disabled = false }) {
  const queryClient = useQueryClient()
  const fieldId = React.useId()
  const draftKey = React.useMemo(
    () => ['video-metadata-draft', libraryId, video.id],
    [libraryId, video.id],
  )
  const category = video.category ?? ''
  const tags = video.tags ?? ''
  // Keep unsaved input when the detail panel unmounts on a selection or tab change.
  // This cache stays in memory and is separate from server-owned video queries.
  const { data: draft } = useQuery({
    queryKey: draftKey,
    queryFn: () => createDraft(category, tags),
    initialData: () => createDraft(category, tags),
    enabled: false,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  })
  const options = useVideoMetadataOptions(libraryId, Boolean(video.removalMode), !disabled)

  React.useEffect(() => {
    queryClient.setQueryData(draftKey, (current) => {
      if (!current) return createDraft(category, tags)
      if (current.observedCategory === category && current.observedTags === tags) return current
      // Refresh untouched fields, but never replace a local edit or an in-flight save.
      return {
        ...current,
        observedCategory: category,
        observedTags: tags,
        ...(current.pending
          ? {}
          : {
              category: categoryChanged(current) ? current.category : category,
              tags: tagsChanged(current) ? current.tags : tags,
              savedCategory: category,
              savedTags: tags,
            }),
      }
    })
  }, [category, tags, draftKey, queryClient])

  const save = useMutation({
    mutationFn: async (submitted) => {
      const result = await window.api.videos.updateMeta(
        submitted.libraryId,
        submitted.videoId,
        submitted.patch,
      )
      if (!result.ok) throw new Error(result.error)
    },
    onMutate: (submitted) => {
      queryClient.setQueryData(submitted.draftKey, (current) => ({
        ...current,
        pending: true,
        error: null,
        saved: false,
      }))
    },
    onSuccess: async (_result, submitted) => {
      queryClient.setQueryData(submitted.draftKey, (current) => ({
        ...current,
        category:
          current.category === submitted.category ? submitted.patch.category : current.category,
        tags: current.tags === submitted.tags ? submitted.patch.tags : current.tags,
        savedCategory: submitted.patch.category,
        savedTags: submitted.patch.tags,
        pending: false,
        error: null,
        saved: true,
      }))
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['video', submitted.libraryId, submitted.videoId],
        }),
        queryClient.invalidateQueries({ queryKey: ['videos', submitted.libraryId] }),
        queryClient.invalidateQueries({
          queryKey: ['video-metadata-options', submitted.libraryId],
        }),
        queryClient.invalidateQueries({ queryKey: ['stats', submitted.libraryId] }),
      ])
    },
    onError: (error, submitted) => {
      queryClient.setQueryData(submitted.draftKey, (current) => ({
        ...current,
        pending: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    },
  })

  const hasChanges = categoryChanged(draft) || tagsChanged(draft)
  function changeField(field, value) {
    queryClient.setQueryData(draftKey, (current) => ({
      ...current,
      [field]: value,
      error: null,
      saved: false,
    }))
  }
  function submit(event) {
    event.preventDefault()
    const current = queryClient.getQueryData(draftKey)
    if (disabled || current.pending || (!categoryChanged(current) && !tagsChanged(current))) return
    save.mutate({
      libraryId,
      videoId: video.id,
      draftKey,
      category: current.category,
      tags: current.tags,
      patch: {
        category: normalizeVideoCategory(current.category),
        tags: serializeVideoTags(current.tags),
      },
    })
  }

  return (
    <form onSubmit={submit} aria-label="영상 분류 편집" className="space-y-3">
      <div>
        <label htmlFor={`${fieldId}-category`} className="mb-1 block text-xs text-zinc-400">
          카테고리
        </label>
        <input
          id={`${fieldId}-category`}
          list={`${fieldId}-categories`}
          value={draft.category}
          onChange={(event) => changeField('category', event.target.value)}
          disabled={disabled}
          autoComplete="off"
          placeholder="기존 카테고리 선택 또는 새로 입력"
          className="w-full rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-hidden focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        <datalist id={`${fieldId}-categories`}>
          {(options.data?.categories ?? []).map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
      </div>
      <div>
        <label htmlFor={`${fieldId}-tags`} className="mb-1 block text-xs text-zinc-400">
          태그
        </label>
        <input
          id={`${fieldId}-tags`}
          value={draft.tags}
          onChange={(event) => changeField('tags', event.target.value)}
          disabled={disabled}
          aria-describedby={`${fieldId}-tags-help`}
          placeholder="#선수명 #리그 또는 쉼표로 구분"
          className="w-full rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-hidden focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
        />
        <p id={`${fieldId}-tags-help`} className="mt-1 text-xs leading-relaxed text-zinc-500">
          #선수명 #리그 또는 쉼표로 구분합니다. 비우고 저장하면 삭제됩니다.
        </p>
      </div>
      {options.isError && !disabled && (
        <p className="text-xs text-amber-200">
          기존 카테고리를 불러오지 못했습니다. 직접 입력할 수 있습니다.{' '}
          <button
            type="button"
            onClick={() => void options.refetch()}
            disabled={options.isFetching}
            className="underline disabled:opacity-50"
          >
            분류 목록 다시 불러오기
          </button>
        </p>
      )}
      {draft.error && (
        <p role="alert" className="break-words text-xs text-red-300">
          분류를 저장하지 못했습니다: {draft.error} 입력한 내용은 유지됩니다. 다시 저장해 주세요.
        </p>
      )}
      <p role="status" className="text-xs text-zinc-400">
        {disabled
          ? '제거한 영상은 목록을 복구한 뒤 수정할 수 있습니다.'
          : draft.pending
            ? '분류를 저장하고 있습니다. 추가 입력은 다음 저장에 반영됩니다.'
            : hasChanges
              ? '저장하지 않은 변경 사항이 있습니다.'
              : draft.saved
                ? '분류를 저장했습니다.'
                : ''}
      </p>
      <button
        type="submit"
        disabled={disabled || draft.pending || !hasChanges}
        className="w-full rounded bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        분류 저장
      </button>
    </form>
  )
}
