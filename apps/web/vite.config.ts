import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import {
  DEFAULT_HOME,
  RELEASE_HOME,
  devInstance,
  isReleaseHome,
} from '../../scripts/dev-instance.ts'

export default defineConfig(({ command }) => {
  if (command === 'build') return { plugins: [react(), tailwindcss()] }
  const home = resolve(process.env.TANIA_HOME || DEFAULT_HOME)
  // release の Tab は TANIA_HOME=~/.tania を継ぐので、そこで起こすと dev の画面から release の note に書きかねない。
  if (isReleaseHome(home)) {
    throw new Error(
      `TANIA_HOME が release の home（${RELEASE_HOME}）です。dev の home を渡してください`,
    )
  }
  const { notesPort, webPort } = devInstance(home)
  // 同じ home の Backend が居なくても他の口に倒さず、dev の画面から release の note に書かない。
  // Host を書き換えないと、notes の口が DNS rebinding として断る。
  const toNotesListener = { target: `http://127.0.0.1:${notesPort}`, changeOrigin: true }
  return {
    plugins: [react(), tailwindcss()],
    clearScreen: false,
    server: {
      port: webPort,
      strictPort: true,
      proxy: { '/rpc': toNotesListener, '/api/assets': toNotesListener },
    },
  }
})
