import type { WindowApi } from './index'

declare global {
  interface Window {
    api: WindowApi
  }
}
