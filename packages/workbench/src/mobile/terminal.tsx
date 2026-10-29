import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import type { RemoteWorkbench, TerminalDisplay, TerminalTarget } from './remote-workbench.ts'

import '@xterm/xterm/css/xterm.css'

export function TerminalOutput({
  remote,
  target,
  back,
}: {
  remote: RemoteWorkbench
  target: TerminalTarget
  back: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<Parameters<TerminalDisplay['state']>[0]>('waiting')
  useEffect(() => {
    if (!container.current) return
    const term = new Terminal({
      disableStdin: true,
      screenReaderMode: true,
      scrollback: 5000,
      fontSize: 14,
      allowProposedApi: true,
    })
    term.parser.registerOscHandler(52, () => true)
    term.parser.registerOscHandler(1337, () => true)
    term.attachCustomKeyEventHandler(() => false)
    term.open(container.current)
    const view = remote.openTerminal(target, {
      write: (bytes) => new Promise((resolve) => term.write(bytes, resolve)),
      size: (rows, cols) => term.resize(cols, rows),
      state: setState,
    })
    return () => {
      void view.close()
      term.dispose()
    }
  }, [remote, target])
  const labels = {
    waiting: '末尾を読み込み中…',
    viewing: '閲覧中 · 入力不可',
    exited: 'Terminal Sessionは終了しました',
    closed: '表示接続を解除しました。Macの作業は継続します。',
    'detach-pending': '表示は停止しました。解除確認待ち。',
    unavailable: '切断しました。自動再接続は行いません。',
    'approval-required': '登録が失効しました。',
    'identity-changed': 'Macのidentityを確認してください。',
    incompatible: 'アプリを更新してください。',
  }
  return (
    <section aria-label="Terminal Sessionの閲覧">
      <button onClick={back}>一覧へ戻る · 表示解除</button>
      <p role="status" aria-live="polite">
        {labels[state]}
      </p>
      <p>
        保持された末尾だけを表示します。完全な履歴やTUI画面の復元は保証しません。入力はできません。サイズはMacが決めます。
      </p>
      <div className="terminal-viewport">
        <div ref={container} />
      </div>
    </section>
  )
}
