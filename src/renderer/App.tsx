import TemporaryPlaybackBoundary from './components/player/TemporaryPlaybackBoundary'
import AppRouter from './router'
import PrivacyBoundary from './components/privacy/PrivacyBoundary'

export default function App() {
  return (
    <PrivacyBoundary>
      <TemporaryPlaybackBoundary>
        <AppRouter />
      </TemporaryPlaybackBoundary>
    </PrivacyBoundary>
  )
}
