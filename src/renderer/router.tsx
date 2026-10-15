import { RouterProvider, createHashRouter } from 'react-router-dom'
import MainLayout from './components/layout/MainLayout'
import LibraryPage from './pages/LibraryPage'
import PlayerPage from './pages/PlayerPage'
import StatsPage from './pages/StatsPage'
import SubtitleQueuePage from './pages/SubtitleQueuePage'
import DiscoveryPage from './pages/DiscoveryPage'
import LibraryMaintenancePage from './pages/LibraryMaintenancePage'

const router = createHashRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
      { path: 'discover', element: <DiscoveryPage /> },
      {
        index: true,
        element: <LibraryPage />,
      },
      {
        path: 'stats',
        element: <StatsPage />,
      },
      {
        path: 'subtitles',
        element: <SubtitleQueuePage />,
      },
      {
        path: 'maintenance',
        element: <LibraryMaintenancePage />,
      },
    ],
  },
  {
    path: '/player/:libraryId/:videoId',
    element: <PlayerPage />,
  },
])

export default function AppRouter() {
  return <RouterProvider router={router} />
}
