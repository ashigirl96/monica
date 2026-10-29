import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import type {
  RemoteWorkbench,
  TerminalDisplay,
  TerminalTarget,
  TerminalView,
} from './remote-workbench.ts'

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
  const viewRef = useRef<TerminalView | undefined>(undefined)
  const [ready, setReady] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState('')
  const [state, setState] = useState<Parameters<TerminalDisplay['state']>[0]>('waiting')
  useEffect(() => {
    if (!container.current) return
    let current = true
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
      write: (bytes) =>
        new Promise((resolve) =>
          term.write(bytes, () => {
            // xterm's write callback ends parsing, not painting.
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
        ),
      inputReady: (available) => {
        if (current) setReady(available)
      },
      size: (rows, cols) => term.resize(cols, rows),
      state: (next) => {
        if (current) setState(next)
      },
    })
    viewRef.current = view
    return () => {
      viewRef.current = undefined
      current = false
      void view.close()
      term.dispose()
    }
  }, [remote, target])
  const labels = {
    waiting: '末尾を読み込み中…',
    viewing: ready ? '閲覧中 · Macと共有入力' : '閲覧中 · Mac renderer待ち（入力不可）',
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
      <p>入力はMacと共有され、同時操作で混ざります。</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          const view = viewRef.current
          if (!view || !ready || sending) return
          setSending(true)
          setResult('送信中…')
          const outcome = await view.input(new TextEncoder().encode(`${text}\r`))
          if (viewRef.current !== view) return
          setSending(false)
          setResult(
            {
              accepted: 'Macの中継が受理しました。実行結果は出力で確認してください。',
              'not-sent': '未送信です。Macの状態と入力上限64KiBを確認してください。',
              uncertain:
                '送達不明です。自動再送しません。出力を確認し、同じコマンドの二重実行を避けてください。',
            }[outcome],
          )
          if (outcome === 'accepted') setText('')
        }}
      >
        <label>
          共有Terminal Sessionへの入力
          <input
            aria-label="共有Terminal Sessionへの入力"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={!ready || sending}
          />
        </label>
        <button type="submit" disabled={!ready || sending}>
          {sending ? '送信中…' : '送信（改行）'}
        </button>
      </form>
      <p role="status" aria-live="polite">
        {result}
      </p>
      <div className="terminal-viewport">
        <div ref={container} />
      </div>
      <p>
        保持された末尾だけを表示します。完全な履歴やTUI画面の復元は保証しません。サイズはMacが決めます。過去の未回答queryを待つTUIは接続だけでは回復しない場合があります。
      </p>
      <p>
        受理はコマンドの実行成功を意味しません。失効前に受理した入力は失効開始後に届く場合があり、取り消せません。
      </p>
    </section>
  )
}
