// Restored application logic from the packaged 0.1.0 release; vendor code is imported from npm.
import * as React from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useLibraries, useOpenLibrary } from '../../api/useLibraries'
import { useLibraryStore } from '../../store/libraryStore'
import SettingsDialog from '../settings/SettingsDialog'
import PlaybackHelpButton from '../player/PlaybackHelpButton'
import { requestPrivacyExit } from '../privacy/PrivacyBoundary'
function AppHeader() {
  const { data: libraries = [], isLoading } = useLibraries()
  const { activeLibraryId, libraryTransitionPending } = useLibraryStore()
  const location = useLocation()
  const navigate = useNavigate()
  const openLibrary = useOpenLibrary()
  const [switchError, setSwitchError] = React.useState(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  React.useEffect(() => setSwitchError(null), [activeLibraryId])
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
      <div className="flex min-w-0 items-center gap-2">
        <select
          aria-label="라이브러리 전환"
          value={activeLibraryId ?? ''}
          disabled={isLoading || libraryTransitionPending || !libraries.length}
          onChange={(event) => {
            const libraryId = event.target.value
            if (!libraryId || libraryId === activeLibraryId || libraryTransitionPending) return
            setSwitchError(null)
            openLibrary.mutate(libraryId, {
              onSuccess: () => navigate('/'),
              onError: (error) => setSwitchError(error.message),
            })
          }}
          className="max-w-52 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
        >
          {!activeLibraryId && <option value="">라이브러리 선택</option>}
          {libraries.map((library) => (
            <option key={library.id} value={library.id}>
              {library.name}
            </option>
          ))}
        </select>
        <Link
          to="/?manage=1"
          className="rounded px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          라이브러리 관리
        </Link>
        {libraryTransitionPending && (
          <span role="status" className="text-xs text-zinc-400">
            라이브러리 여는 중...
          </span>
        )}
        {switchError && (
          <span role="alert" className="max-w-64 text-xs text-red-300">
            {switchError}
          </span>
        )}
      </div>
      <nav className={'ml-2 flex items-center gap-2'}>
        <Link
          to="/discover"
          className="rounded px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          추천 탐색
        </Link>
        <Link
          to="/maintenance"
          className={`rounded px-3 py-1.5 text-xs ${location.pathname === '/maintenance' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800'}`}
        >
          파일 정리
        </Link>
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
      <button
        type="button"
        onClick={requestPrivacyExit}
        title="Ctrl+Shift+H"
        className="rounded border border-zinc-700 px-3 py-1.5 text-xs"
      >
        화면 숨기기
      </button>
      {isLoading && <span className={'text-xs text-zinc-500'}>{'불러오는 중...'}</span>}
      <PlaybackHelpButton />
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
