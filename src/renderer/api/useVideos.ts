import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query'
import { videosApi } from '../api'
import type { SearchQuery, VideoMeta } from '@shared/types'

export function useVideoMetadataOptions(libraryId: string, removed = false, enabled = true) {
  return useQuery({
    queryKey: ['video-metadata-options', libraryId, removed],
    queryFn: async () => {
      const result = await window.api.videos.metadataOptions(libraryId, removed)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled: Boolean(libraryId) && enabled,
    staleTime: 30_000,
  })
}

export function useVideos(libraryId: string, query: SearchQuery, enabled = true) {
  const result = useInfiniteQuery({
    queryKey: ['videos', libraryId, query],
    queryFn: async ({ pageParam }) => {
      const res = await window.api.videos.search(libraryId, {
        ...query,
        page: pageParam,
        pageSize: 500,
      })
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.videos.length, 0)
      return lastPage.videos.length > 0 && loaded < lastPage.total ? lastPage.page + 1 : undefined
    },
    enabled: Boolean(libraryId) && enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const first = result.data?.pages[0]
  return {
    ...result,
    data: first
      ? { ...first, videos: result.data!.pages.flatMap((page) => page.videos) }
      : undefined,
  }
}

export function useVideo(libraryId: string, videoId: string) {
  return useQuery({
    queryKey: ['video', libraryId, videoId],
    queryFn: async () => {
      const res = await videosApi.get(libraryId, videoId)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    enabled: !!libraryId && !!videoId,
  })
}

export function useUpdateVideoMeta(libraryId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ videoId, meta }: { videoId: string; meta: VideoMeta }) => {
      const res = await videosApi.updateMeta(libraryId, videoId, meta)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['videos', libraryId] })
      qc.invalidateQueries({ queryKey: ['video', libraryId] })
      qc.invalidateQueries({ queryKey: ['video-metadata-options', libraryId] })
      qc.invalidateQueries({ queryKey: ['stats', libraryId] })
    },
  })
}

export function useDeleteVideo(libraryId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (videoId: string) => {
      const res = await videosApi.delete(libraryId, videoId)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['videos', libraryId] })
      qc.invalidateQueries({ queryKey: ['video-metadata-options', libraryId] })
    },
  })
}
