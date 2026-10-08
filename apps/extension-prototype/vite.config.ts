import { crx, defineManifest } from '@crxjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const manifest = defineManifest({
  manifest_version: 3,
  name: 'monica (prototype: side panel chat)',
  version: '0.0.0',
  action: {},
  background: { service_worker: 'src/background.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  permissions: ['sidePanel'],
})

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  server: { port: 5198, strictPort: true },
})
