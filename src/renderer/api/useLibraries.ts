// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { libraryApi } from './index'

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
    mutationFn: async ({ name, folderPath }: { name: string; folderPath: string }) => {
      const res = await libraryApi.create(name, folderPath)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: () => qc2.invalidateQueries({ queryKey: ['libraries'] }),
  })
}
function useOpenLibrary() {
  const qc2 = useQueryClient()
  return useMutation({
    mutationFn: async (libraryId: string) => {
      const res = await libraryApi.open(libraryId)
      if (!res.ok) throw new Error(res.error)
      return res.value
    },
    onSuccess: (lib) => {
      qc2.invalidateQueries({ queryKey: ['libraries'] })
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
