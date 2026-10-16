// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Library } from '@shared/types'
import type { Result } from '@shared/result'
import { useLibraryStore } from '../store/libraryStore'
import { libraryApi } from './index'

async function transitionLibrary(
  action: () => Promise<Result<Library, string>>,
  queryClient: QueryClient,
) {
  const store = useLibraryStore.getState()
  if (store.libraryTransitionPending)
    throw new Error('라이브러리를 여는 중입니다. 잠시 기다려 주세요.')
  store.setLibraryTransitionPending(true)
  try {
    const response = await action()
    if (!response.ok) throw new Error(response.error)
    await queryClient.invalidateQueries({ queryKey: ['libraries'] })
    // Keep the previous library visible until the new database has opened.
    // Existing database handles stay alive for their background jobs.
    useLibraryStore.getState().activateLibrary(response.value)
    return response.value
  } finally {
    store.setLibraryTransitionPending(false)
  }
}

function useLibraries() {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: async () => {
      const res = await libraryApi.list()
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
  })
}
function useCreateLibrary() {
  const qc2 = useQueryClient()
  return useMutation({
    mutationFn: ({ name, folderPath }: { name: string; folderPath: string | string[] }) =>
      transitionLibrary(() => libraryApi.create(name, folderPath), qc2),
  })
}
function useOpenLibrary() {
  const qc2 = useQueryClient()
  return useMutation({
    mutationFn: (libraryId: string) => transitionLibrary(() => libraryApi.open(libraryId), qc2),
    onSuccess: (lib) => {
      qc2.invalidateQueries({ queryKey: ['videos', lib.id] })
      qc2.invalidateQueries({ queryKey: ['video-metadata-options', lib.id] })
    },
  })
}
function useDeleteLibrary() {
  const qc2 = useQueryClient()
  return useMutation({
    mutationFn: async (libraryId: string) => {
      const res = await libraryApi.delete(libraryId)
      if (!res.ok) throw new Error(res.error)
    },
    onSuccess: () => qc2.invalidateQueries({ queryKey: ['libraries'] }),
  })
}

export { useLibraries, useCreateLibrary, useOpenLibrary, useDeleteLibrary }
