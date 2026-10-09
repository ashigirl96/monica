import { crx, defineManifest } from '@crxjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { devHome, devInstance, extensionDevOutput } from '../../scripts/dev-instance.ts'
import { DEV_NATIVE_HOST, RELEASE_NATIVE_HOST } from '../../scripts/native-host.ts'

// key は公開鍵の DER の base64 で、ID を固定する（ADR-0029）。ID と鍵の作り方は docs/packages/extension.md にある。
const RELEASE = {
  name: 'Monica',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuHoAgFcS1qQ4pN2xjNjHf6YprMN+GS1cf1Xa3b/BCHrWAujmObBMXHTL3Wt1FtskqE3YViSYzW1C9VyTy08qptaY8zDWb36bYS6QUy3vr3V9FlNI6FhqQz/dcBdwZHQ5AbdI56sqeB3ddunp9PT8eSpR+7EzqBXnFf30/Xxyn2OGJ0rOCLYnZ4EoBWR7YKNRAzEMl1ezYDwhNOD+4QMUh1o0dceBJe5K3jQNMzvhia4YICblk8QEMl1Uzkw2/pyHxnLJXrPCyqstMAqwREplyL8J52sr8u4UPR2LFvnZLfW3FLWJtoVK05SVr66w31wmLA66H6eCJrkzFVafSoHUFwIDAQAB',
}
const DEV = {
  name: 'Monica (dev)',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtH8oUl7mUkzcANrl/ZmduZ/cPvMmzl+dInEsA3kX+9f94ulc0vnCL0sirzttz2fbz+hZnDzX9vohsqI/LoVHpvSgMOrtbRWYqK34dqcYGgTjEhwZN350FE/f9p5JkULNKyfDcCzzyOukIiw5scRC1WMZM7GjXNchi9NH13gkNz32EII61r02rGZ8jw9w/YILCC+GpWO2umtKSum/f/r9598SallGjuXfFDg1c7fwl9X+6Ew5FIBYKxiRGfnXQUpq4WvH59AXMrAoxpyK6zaHuTOAsArIWBaj3fB4qaafaMEW9DWGjhWqm4+QkvEBZsHAW5wkgiAT3b1o0dTbrP3f6QIDAQAB',
}

const ICONS = {
  16: 'icons/16.png',
  32: 'icons/32.png',
  48: 'icons/48.png',
  128: 'icons/128.png',
}

// key を outDir と同じ mode で選ぶので、dev の出力に release の key が入らない。
const manifest = defineManifest(({ mode }) => ({
  manifest_version: 3,
  ...(mode === 'production' ? RELEASE : DEV),
  version: '0.1.0',
  icons: ICONS,
  action: { default_icon: ICONS },
  background: { service_worker: 'src/background.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  // GitHub の Issues の一覧の行に Run ボタンを差し込む（ADR-0035）。GitHub は `/` や `/issues` からも client 側で移り、そこでは注入されないので、
  // github.com の画面すべてに注入し、一覧かは script が URL で見る。
  content_scripts: [{ matches: ['https://github.com/*'], js: ['src/issues-list.ts'] }],
  // scripting は、質問を送った時に Current Page の HTML と選択範囲を読む。
  // nativeMessaging は、Backend の token の口の port と Chrome Extension の token を host から引く（ADR-0034）。
  permissions: ['sidePanel', 'scripting', 'nativeMessaging'],
  // Current Page の url と title を読み、Backend の token の口（loopback）を呼ぶ。
  host_permissions: ['<all_urls>'],
  // 答えに埋めた画像を読み込ませない。URL に載せた Chat の中身が外へ出るため。
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; img-src 'self' data:",
  },
}))

// release と dev の host は別の manifest に別の Chrome Extension の ID を許すので、mode で host 名を焼き込む。
const nativeHost = (name: string) => ({ __MONICA_NATIVE_HOST__: JSON.stringify(name) })

export default defineConfig(({ command, mode }) => {
  const plugins = [react(), tailwindcss(), crx({ manifest })]
  if (command === 'build') {
    return {
      plugins,
      define: nativeHost(RELEASE_NATIVE_HOST),
      build: { outDir: `dist/${mode}` },
    }
  }
  const home = devHome()
  // dev の出力に port が焼き込まれるので、空いている別の port に移らない。
  const { extensionPort } = devInstance(home)
  return {
    plugins,
    // dev の host は dev の Brave の MONICA_HOME の Backend を返し、release の Backend を返さない。
    define: nativeHost(DEV_NATIVE_HOST),
    // CRXJS は dev も build.outDir に書くので、check:ts の build が dev で読み込んでいる中身を置き換えないよう分ける。
    build: { outDir: extensionDevOutput(home) },
    clearScreen: false,
    server: {
      port: extensionPort,
      strictPort: true,
      // check:ts の build が dist/production に書くたびに、dev の side panel を読み直させない。
      watch: { ignored: ['**/dist/**'] },
    },
  }
})
