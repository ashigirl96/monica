import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

import {
  DEFAULT_HOME,
  RELEASE_HOME,
  devInstance,
  isReleaseHome,
} from '../../scripts/dev-instance.ts'

export default defineConfig(({ command }) => {
  if (command === 'build') return { plugins: [react(), tailwindcss()] }
  const home = resolve(process.env.MONICA_HOME || DEFAULT_HOME)
  // release の Tab は MONICA_HOME=~/.monica を継ぐので、そこで起こすと dev の画面から release の note に書きかねない。
  if (isReleaseHome(home)) {
    throw new Error(
      `MONICA_HOME が release の home（${RELEASE_HOME}）です。dev の home を渡してください`,
    )
  }
  const { browserPort, webPort } = devInstance(home)
  // 同じ home の Backend が居なくても他の口に倒さず、dev の画面から release の note に書かない。
  // Host を書き換えないと、ブラウザの口が DNS rebinding として断る。
  const toBrowserListener: ProxyOptions = {
    target: `http://127.0.0.1:${browserPort}`,
    changeOrigin: true,
    // release では Backend が居ないと接続が拒まれるので、502 を返さずに切り、画面に同じ network error を見せる。
    configure: (proxy) => {
      proxy.on('error', (_error, _request, response) => {
        if ('req' in response) response.socket?.destroy()
      })
    },
  }
  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
      port: webPort,
      strictPort: true,
      proxy: { '/rpc': toBrowserListener, '/api/assets': toBrowserListener },
    },
  }
})
