import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Library, SearchQuery } from '@shared/types'

type SortPreference = Pick<SearchQuery, 'sortBy' | 'sortDir'>
const DEFAULT_SORT: SortPreference = { sortBy: 'createdAt', sortDir: 'desc' }

interface LibraryState {
  activeLibraryId: string | null
  openedLibraryId: string | null
  selectedVideoId: string | null
  sortPreferencesByLibraryId: Record<string, SortPreference>
  searchTextByLibraryId: Record<string, string>
  withoutSubtitlesByLibraryId: Record<string, boolean>
  scrollTopByLibraryId: Record<string, number>
  playerVolume: number
  setActiveLibrary: (library: Library | null) => void
  setOpenedLibraryId: (id: string | null) => void
  setSelectedVideoId: (id: string | null) => void
  setSortPreference: (id: string, sort: SortPreference) => void
  getSortPreference: (id: string | null) => SortPreference
  setSearchText: (id: string, value: string) => void
  getSearchText: (id: string | null) => string
  setWithoutSubtitles: (id: string, value: boolean) => void
  getWithoutSubtitles: (id: string | null) => boolean
  setScrollTop: (id: string, value: number) => void
  getScrollTop: (id: string | null) => number
  setPlayerVolume: (value: number) => void
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set, get) => ({
      activeLibraryId: null,
      openedLibraryId: null,
      selectedVideoId: null,
      sortPreferencesByLibraryId: {},
      searchTextByLibraryId: {},
      withoutSubtitlesByLibraryId: {},
      scrollTopByLibraryId: {},
      playerVolume: 1,
      setActiveLibrary: (library) => set({ activeLibraryId: library?.id ?? null }),
      setOpenedLibraryId: (openedLibraryId) => set({ openedLibraryId }),
      setSelectedVideoId: (selectedVideoId) => set({ selectedVideoId }),
      setSortPreference: (id, sort) =>
        set((state) => ({
          sortPreferencesByLibraryId: { ...state.sortPreferencesByLibraryId, [id]: sort },
        })),
      getSortPreference: (id) =>
        id ? (get().sortPreferencesByLibraryId[id] ?? DEFAULT_SORT) : DEFAULT_SORT,
      setSearchText: (id, value) =>
        set((state) => ({
          searchTextByLibraryId: { ...state.searchTextByLibraryId, [id]: value },
        })),
      getSearchText: (id) => (id ? (get().searchTextByLibraryId[id] ?? '') : ''),
      setWithoutSubtitles: (id, value) =>
        set((state) => ({
          withoutSubtitlesByLibraryId: { ...state.withoutSubtitlesByLibraryId, [id]: value },
        })),
      getWithoutSubtitles: (id) => (id ? (get().withoutSubtitlesByLibraryId[id] ?? false) : false),
      setScrollTop: (id, value) =>
        set((state) => ({
          scrollTopByLibraryId: { ...state.scrollTopByLibraryId, [id]: Math.max(0, value) },
        })),
      getScrollTop: (id) => (id ? (get().scrollTopByLibraryId[id] ?? 0) : 0),
      setPlayerVolume: (value) => set({ playerVolume: Math.max(0, Math.min(1, value)) }),
    }),
    {
      name: 'dark-video-manager-library-store',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sortPreferencesByLibraryId: state.sortPreferencesByLibraryId,
        searchTextByLibraryId: state.searchTextByLibraryId,
        withoutSubtitlesByLibraryId: state.withoutSubtitlesByLibraryId,
        scrollTopByLibraryId: state.scrollTopByLibraryId,
        playerVolume: state.playerVolume,
      }),
    },
  ),
)
