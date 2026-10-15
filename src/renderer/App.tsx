import AppRouter from './router'
import PrivacyBoundary from './components/privacy/PrivacyBoundary'

export default function App() {
  return (
    <PrivacyBoundary>
      <AppRouter />
    </PrivacyBoundary>
  )
}
