import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SubtitleGenerationJob } from '@shared/types'

const terminalPhases = new Set(['completed', 'cancelled', 'failed'])

/** One shared queue request serves every visible card, including unselected videos. */
export function useLibrarySubtitleJobs(libraryId: string | null, enabled: boolean) {
  const queryClient = useQueryClient()
  const observed = useRef(
    new Map<string, { libraryId: string; videoId: string; signature: string }>(),
  )
  const queue = useQuery({
    queryKey: ['subtitle-queue'],
    queryFn: async () => {
      const result = await window.api.subtitles.listQueue()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled: enabled && !!libraryId,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.some((job) => !terminalPhases.has(job.phase)) ? 1000 : 5000,
    refetchIntervalInBackground: true,
    retry: false,
  })

  const jobsByVideo = useMemo(() => {
    const result = new Map<string, SubtitleGenerationJob>()
    if (!enabled || !libraryId) return result
    // Prefer an unfinished job even when an older failed job was resumed after newer history.
    for (const job of queue.data ?? []) {
      if (job.libraryId !== libraryId) continue
      const previous = result.get(job.videoId)
      if (!previous || terminalPhases.has(previous.phase) || !terminalPhases.has(job.phase))
        result.set(job.videoId, job)
    }
    return result
  }, [enabled, libraryId, queue.data])

  useEffect(() => {
    if (!enabled || !libraryId || !queue.data) return
    const updatedVideos = new Set<string>()
    const jobIds = new Set(queue.data.map((job) => job.id))
    for (const [id, previous] of observed.current) {
      if (!jobIds.has(id)) {
        if (previous.libraryId === libraryId) updatedVideos.add(previous.videoId)
        observed.current.delete(id)
      }
    }
    for (const job of queue.data) {
      if (job.libraryId !== libraryId) continue
      const signature = JSON.stringify([job.phase, job.message, job.outputPaths])
      const previous = observed.current.get(job.id)?.signature
      observed.current.set(job.id, { libraryId, videoId: job.videoId, signature })
      if (terminalPhases.has(job.phase) && previous !== signature) updatedVideos.add(job.videoId)
    }
    // Completion must update the normal subtitle badge even if details were never opened.
    if (!updatedVideos.size) return
    for (const videoId of updatedVideos) {
      for (const key of [
        'subtitles',
        'subtitle-tracks',
        'subtitle-cues',
        'video',
        'subtitle-generation',
      ])
        void queryClient.invalidateQueries({ queryKey: [key, libraryId, videoId] })
    }
    void queryClient.invalidateQueries({ queryKey: ['videos', libraryId] })
    void queryClient.invalidateQueries({ queryKey: ['stats', libraryId] })
  }, [enabled, libraryId, queryClient, queue.data])

  return { jobsByVideo, error: queue.error, refetch: queue.refetch, isFetching: queue.isFetching }
}
