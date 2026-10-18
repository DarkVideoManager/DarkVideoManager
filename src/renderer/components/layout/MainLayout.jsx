// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import AppHeader from './AppHeader'
import GitHubStarNotice from './GitHubStarNotice'
import AppUpdateNotice from './AppUpdateNotice'
import PlaybackConversionQueue from '../player/PlaybackConversionQueue'
import { useLibraries, useOpenLibrary } from '../../api/useLibraries'
import { useLibraryStore } from '../../store/libraryStore'
function MainLayout() {
  const location = useLocation()
  const librariesQuery = useLibraries()
  const activeLibraryId = useLibraryStore((s2) => s2.activeLibraryId)
  const openedLibraryId = useLibraryStore((s2) => s2.openedLibraryId)
  const setActiveLibrary = useLibraryStore((s2) => s2.setActiveLibrary)
  const setOpenedLibraryId = useLibraryStore((s2) => s2.setOpenedLibraryId)
  const openLibrary = useOpenLibrary()
  React.useEffect(() => {
    if (!activeLibraryId || !librariesQuery.data) return
    const exists = librariesQuery.data.some((library) => library.id === activeLibraryId)
    if (!exists) {
      setActiveLibrary(null)
      setOpenedLibraryId(null)
    }
  }, [activeLibraryId, librariesQuery.data, setActiveLibrary, setOpenedLibraryId])
  React.useEffect(() => {
    if (!activeLibraryId) {
      if (openedLibraryId !== null) {
        setOpenedLibraryId(null)
      }
      return
    }
    if (openedLibraryId === activeLibraryId || openLibrary.isPending) {
      return
    }
    openLibrary.mutate(activeLibraryId, {
      onSuccess: (library) => {
        setOpenedLibraryId(library.id)
      },
      onError: () => {
        setOpenedLibraryId(null)
        setActiveLibrary(null)
      },
    })
  }, [activeLibraryId, openLibrary, openedLibraryId, setActiveLibrary, setOpenedLibraryId])
  return (
    <div className={'flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100'}>
      <AppHeader />
      <GitHubStarNotice />
      <AppUpdateNotice />
      {location.pathname === '/' && <PlaybackConversionQueue />}
      <main className={'flex min-h-0 min-w-0 flex-1 overflow-hidden'}>
        <Outlet />
      </main>
    </div>
  )
}
export default MainLayout
