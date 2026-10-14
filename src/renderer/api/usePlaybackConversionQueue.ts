import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PlaybackConversionJob } from '@shared/playbackConversion'

export const playbackConversionQueueKey = ['playback-conversion-queue'] as const

export function usePlaybackConversionQueue(enabled = true) {
  return useQuery({
    queryKey: playbackConversionQueueKey,
    queryFn: async () => {
      const result = await window.api.playback.listConversionQueue()
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    enabled,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.some((job) => ['queued', 'running'].includes(job.status)) ? 1000 : 2000,
    refetchIntervalInBackground: true,
    retry: false,
  })
}

export function usePlaybackConversionAction(job: PlaybackConversionJob) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (action: 'pause' | 'resume' | 'remove') => {
      const result = await (action === 'pause'
        ? window.api.playback.pauseConversion(job.id)
        : action === 'resume'
          ? window.api.playback.resumeConversion(job.id)
          : window.api.playback.removeConversion(job.id))
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
    onSuccess: (updated) => {
      queryClient.setQueryData<PlaybackConversionJob[]>(playbackConversionQueueKey, (jobs) =>
        jobs?.flatMap((item) => (item.id !== job.id ? [item] : updated ? [updated] : [])),
      )
      void queryClient.invalidateQueries({ queryKey: playbackConversionQueueKey })
    },
  })
}
