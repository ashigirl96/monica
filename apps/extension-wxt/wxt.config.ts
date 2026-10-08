import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'wxt'

export default defineConfig({
  srcDir: 'src',
  imports: false,
  vite: () => ({ plugins: [react(), tailwindcss()] }),
  webExt: { disabled: true },
  manifest: {
    name: 'monica (wxt)',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwLQlLQzE0TblIgwQN9CyrQq3kKZGei70IR9q9VZrbQaaGdNtD6LOV6/slGJKpchHbnifLb1VfBgEUTNgtL23IrMbxCAf8bXJhROjhliOyeE1zLn2gT7wmtXowe4RUIZNh2XQykNs/E/mQWAysT8V4lqiPVa0tYyDYFcPxcbaCzZj40WFzYHa4nIxCuVJ5fAbw2Ltzj/8FYwjEgSN83RcOk1T3bVVSux+qa/FfxF2EUuCiyXZNl1VsvWdLrNh/Hg0LWW3mwlC1SkUDYyIDISIJseIofWtk0kabjt/F2LJ57WD+Rz2v/Dy1mrJ8iztjPXZOoMD9tPMiX0mY5l+OMO8HQIDAQAB',
    action: {},
  },
})
