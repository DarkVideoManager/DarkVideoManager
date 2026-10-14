// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useLibraries } from '../../api/useLibraries'
import { useLibraryStore } from '../../store/libraryStore'
import SettingsDialog from '../settings/SettingsDialog'
function AppHeader() {
  const { data: libraries = [], isLoading } = useLibraries()
  const { activeLibraryId } = useLibraryStore()
  const location = useLocation()
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const activeLibrary = libraries.find((library) => library.id === activeLibraryId) ?? null
  return (
    <header
      className={
        'flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3'
      }
    >
      <div className={'min-w-0'}>
        <p className={'text-sm font-semibold tracking-wide text-zinc-100'}>{'DarkVideoManager'}</p>
        <p className={'text-xs text-zinc-500'}>
          {activeLibrary
            ? `라이브러리: ${activeLibrary.name}`
            : '시작하려면 라이브러리를 선택하세요.'}
        </p>
      </div>
      <nav className={'ml-2 flex items-center gap-2'}>
        <Link
          to={'/'}
          className={`rounded px-3 py-1.5 text-xs ${location.pathname === '/' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
        >
          {'라이브러리'}
        </Link>
        <Link
          to={'/subtitles'}
          className={`rounded px-3 py-1.5 text-xs ${location.pathname === '/subtitles' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
        >
          {'자막 생성'}
        </Link>
        <Link
          to={'/stats'}
          className={`rounded px-3 py-1.5 text-xs ${location.pathname === '/stats' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
        >
          {'통계'}
        </Link>
      </nav>
      <div className={'ml-auto'} />
      {isLoading && <span className={'text-xs text-zinc-500'}>{'불러오는 중...'}</span>}
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setSettingsOpen(true)}
        className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        설정
      </button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  )
}
export default AppHeader
