import { crx, defineManifest } from '@crxjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const manifest = defineManifest({
  manifest_version: 3,
  name: 'monica (crxjs)',
  version: '0.0.0',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwLQlLQzE0TblIgwQN9CyrQq3kKZGei70IR9q9VZrbQaaGdNtD6LOV6/slGJKpchHbnifLb1VfBgEUTNgtL23IrMbxCAf8bXJhROjhliOyeE1zLn2gT7wmtXowe4RUIZNh2XQykNs/E/mQWAysT8V4lqiPVa0tYyDYFcPxcbaCzZj40WFzYHa4nIxCuVJ5fAbw2Ltzj/8FYwjEgSN83RcOk1T3bVVSux+qa/FfxF2EUuCiyXZNl1VsvWdLrNh/Hg0LWW3mwlC1SkUDYyIDISIJseIofWtk0kabjt/F2LJ57WD+Rz2v/Dy1mrJ8iztjPXZOoMD9tPMiX0mY5l+OMO8HQIDAQAB',
  action: {},
  background: { service_worker: 'src/background.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  permissions: ['sidePanel'],
})

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  server: { port: 5199, strictPort: true },
})
