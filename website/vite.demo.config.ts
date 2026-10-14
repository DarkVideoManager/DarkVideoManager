import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserCopy } from './demo/browser-copy'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '..')

export default defineConfig({
  root: resolve(here, 'demo'),
  base: '/demo/',
  envDir: false,
  publicDir: false,
  plugins: [
    {
      name: 'browser-demo-adapters',
      enforce: 'pre',
      resolveId(source, importer) {
        if (importer?.replaceAll('\\', '/').includes('/src/renderer/')) {
          if (source.endsWith('/SubtitleEnvironmentSetup'))
            return resolve(here, 'demo/SubtitleExperience.tsx')
          if (source.endsWith('/SubtitleTranslationSettings'))
            return resolve(here, 'demo/TranslationPreview.tsx')
        }
        if (
          importer?.replaceAll('\\', '/').includes('/src/renderer/') &&
          /(?:^|\/)utils\/media(?:\.ts)?$/.test(source)
        ) {
          return resolve(here, 'demo/media.ts')
        }
      },
      transform(code, id) {
        const adapted = browserCopy(code, id)
        if (adapted !== undefined) return { code: adapted, map: null }
      },
    },
    react(),
  ],
  resolve: {
    alias: {
      '@demo-keyboard': resolve(here, 'demo/keyboard.ts'),
      '@shared': resolve(repository, 'src/shared'),
      '@renderer': resolve(repository, 'src/renderer'),
    },
  },
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    outDir: resolve(here, 'public/demo'),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('recharts') || id.includes('d3-')) return 'charts'
        },
      },
    },
  },
})
