import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

import { devHome, devInstance } from '../../scripts/dev-instance.ts'

export default defineConfig(({ command }) => {
  if (command === 'build') return { plugins: [react(), tailwindcss()] }
  const home = devHome()
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
