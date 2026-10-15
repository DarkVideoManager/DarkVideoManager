import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ThumbnailJob } from '@shared/types'
import { thumbnailsApi } from './index'

const terminalPhases = new Set(['completed', 'failed', 'cancelled'])

/** Poll once per library, so unselected and virtualized videos share the same state. */
export function useThumbnailJobs(libraryId: string | null, enabled = true) {
  const queryClient = useQueryClient()
  const observed = useRef(new Map<string, string>())
  const activeLibrary = useRef(libraryId)
  activeLibrary.current = libraryId
  const [cancelErrors, setCancelErrors] = useState(new Map<string, string>())
  const [cancellingVideos, setCancellingVideos] = useState(new Set<string>())
  const query = useQuery({
    queryKey: ['thumbnail-jobs', libraryId],
    queryFn: async () => {
      const result = await thumbnailsApi.listJobs(libraryId!)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled: enabled && !!libraryId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: 500,
    refetchIntervalInBackground: true,
    retry: false,
  })
  const jobsByVideo = useMemo(() => {
    const jobs = new Map<string, ThumbnailJob>()
    for (const job of query.data ?? []) {
      if (job.libraryId === libraryId) jobs.set(job.videoId, job)
    }
    return jobs
  }, [libraryId, query.data])

  useEffect(() => {
    observed.current.clear()
    setCancelErrors(new Map())
    setCancellingVideos(new Set())
  }, [libraryId])

  useEffect(() => {
    if (!enabled || !libraryId) return
    const currentKeys = new Set([...jobsByVideo.keys()].map((videoId) => `${libraryId}:${videoId}`))
    for (const key of observed.current.keys()) {
      if (!currentKeys.has(key)) observed.current.delete(key)
    }
    let refreshVideos = false
    for (const job of jobsByVideo.values()) {
      const key = `${libraryId}:${job.videoId}`
      const signature = JSON.stringify([job.phase, job.completed, job.total, job.error])
      const previous = observed.current.get(key)
      observed.current.set(key, signature)
      if (previous === signature || !terminalPhases.has(job.phase)) continue
      for (const prefix of ['thumbnails', 'video'])
        void queryClient.invalidateQueries({ queryKey: [prefix, libraryId, job.videoId] })
      refreshVideos = true
    }
    if (refreshVideos) void queryClient.invalidateQueries({ queryKey: ['videos', libraryId] })
  }, [enabled, jobsByVideo, libraryId, queryClient])

  const cancellation = useMutation({
    mutationFn: async ({
      libraryId: targetLibrary,
      videoId,
    }: {
      libraryId: string
      videoId: string
    }) => {
      const result = await thumbnailsApi.cancelForVideo(targetLibrary, videoId)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onMutate: ({ videoId }) => {
      setCancellingVideos((previous) => new Set(previous).add(videoId))
      setCancelErrors((previous) => {
        const next = new Map(previous)
        next.delete(videoId)
        return next
      })
    },
    onError: (error, { libraryId: targetLibrary, videoId }) => {
      if (activeLibrary.current !== targetLibrary) return
      setCancelErrors((previous) =>
        new Map(previous).set(videoId, `취소하지 못했습니다: ${error.message}`),
      )
    },
    onSettled: (_data, _error, { libraryId: targetLibrary, videoId }) => {
      void queryClient.invalidateQueries({ queryKey: ['thumbnail-jobs', targetLibrary] })
      if (activeLibrary.current !== targetLibrary) return
      setCancellingVideos((previous) => {
        const next = new Set(previous)
        next.delete(videoId)
        return next
      })
    },
  })

  return {
    jobsByVideo,
    cancelErrors,
    cancellingVideos,
    cancelVideo: (videoId: string) => {
      if (libraryId) cancellation.mutate({ libraryId, videoId })
    },
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
  }
}
