import { RouterProvider, createHashRouter } from 'react-router-dom'
import MainLayout from './components/layout/MainLayout'
import LibraryPage from './pages/LibraryPage'
import PlayerPage from './pages/PlayerPage'
import StatsPage from './pages/StatsPage'
import SubtitleQueuePage from './pages/SubtitleQueuePage'

const router = createHashRouter([
  {
    path: '/',
    element: <MainLayout />,
    children: [
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
