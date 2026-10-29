import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import type { InputResult } from '../remote-terminal.ts'
import { readClipboardText, writeClipboardText } from './native.ts'
import type {
  RemoteWorkbench,
  PasteResult,
  TerminalDisplay,
  TerminalTarget,
  TerminalView,
} from './remote-workbench.ts'

import '@xterm/xterm/css/xterm.css'

const deliveryLabels = {
  accepted: 'Macの中継が受理しました。実行結果は出力で確認してください。',
  'not-sent': '未送信です。接続とMacの状態を確認してください。',
  uncertain: '送達不明です。自動再送しません。出力を確認し、二重実行を避けてください。',
}
const keys = [
  { name: 'Esc', text: 'Esc', bytes: '\x1b' },
  { name: 'Tab', text: 'Tab', bytes: '\t' },
  { name: '上矢印', text: '↑', cursor: 'A' },
  { name: '下矢印', text: '↓', cursor: 'B' },
  { name: '左矢印', text: '←', cursor: 'D' },
  { name: '右矢印', text: '→', cursor: 'C' },
  { name: '削除', text: '⌫', bytes: '\x7f' },
  { name: 'Enter', text: '↵', bytes: '\r' },
]

function terminalCursorBottom(term: Terminal): number {
  return ((term.element?.clientHeight ?? 0) * (term.buffer.active.cursorY + 1)) / term.rows
}

export function TerminalOutput({
  remote,
  target,
  back,
}: {
  remote: RemoteWorkbench
  target: TerminalTarget
  back: () => void
}) {
  const workspace = useRef<HTMLElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const terminal = useRef<Terminal | undefined>(undefined)
  const viewRef = useRef<TerminalView | undefined>(undefined)
  const composing = useRef(false)
  const busy = useRef(false)
  const selection = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef<HTMLInputElement>(null)
  const pastePreview = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [text, setText] = useState('')
  const [ctrl, setCtrl] = useState(false)
  const [composition, setComposition] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState('')
  const [paste, setPaste] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(14)
  const fontSizeRef = useRef(14)
  const [state, setState] = useState<Parameters<TerminalDisplay['state']>[0]>('waiting')
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      workspace.current?.style.setProperty(
        '--terminal-height',
        `${viewport?.height ?? window.innerHeight}px`,
      )
      workspace.current?.style.setProperty('--terminal-top', `${viewport?.offsetTop ?? 0}px`)
      requestAnimationFrame(() => {
        const draft = draftRef.current
        if (draft && document.activeElement === draft) draft.scrollIntoView({ block: 'nearest' })
      })
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  useEffect(() => {
    const surface = container.current
    const panViewport = viewportRef.current
    if (!surface || !panViewport) return
    let current = true
    let disposeTerminal = () => {}
    const createTerminal = () => {
      const term = new Terminal({
        disableStdin: true,
        screenReaderMode: true,
        scrollback: 5000,
        fontSize: fontSizeRef.current,
        allowProposedApi: true,
      })
      term.parser.registerOscHandler(52, () => true)
      term.parser.registerOscHandler(1337, () => true)
      term.attachCustomKeyEventHandler(() => false)
      term.open(surface)
      terminal.current = term
      let touch: { identifier: number; x: number; y: number; remainder: number } | null = null
      const startPan = (event: TouchEvent) => {
        event.stopPropagation()
        const point = event.touches.length === 1 ? event.touches[0] : undefined
        touch = point
          ? { identifier: point.identifier, x: point.clientX, y: point.clientY, remainder: 0 }
          : null
      }
      const movePan = (event: TouchEvent) => {
        event.stopPropagation()
        const point = event.touches.length === 1 ? event.touches[0] : undefined
        if (!touch || !point || point.identifier !== touch.identifier) {
          touch = null
          return
        }
        event.preventDefault()
        const height = term.element?.clientHeight ?? 0
        const lineHeight = height / term.rows
        if (!lineHeight) return
        const buffer = term.buffer.active
        const top = Math.max(
          0,
          Math.min(
            buffer.baseY * lineHeight + panViewport.scrollHeight - panViewport.clientHeight,
            buffer.viewportY * lineHeight +
              panViewport.scrollTop +
              touch.remainder +
              touch.y -
              point.clientY,
          ),
        )
        const line = Math.min(buffer.baseY, Math.floor(top / lineHeight))
        term.scrollToLine(line)
        panViewport.scrollTop = top - line * lineHeight
        panViewport.scrollLeft += touch.x - point.clientX
        following.current =
          line === buffer.baseY &&
          panViewport.scrollTop + panViewport.clientHeight >= terminalCursorBottom(term) - 1
        touch = {
          identifier: point.identifier,
          x: point.clientX,
          y: point.clientY,
          remainder: top - (buffer.viewportY * lineHeight + panViewport.scrollTop),
        }
      }
      const endPan = (event: TouchEvent) => {
        event.stopPropagation()
        touch = null
      }
      // Own reading touches before xterm's document Gesture listener turns them into input.
      surface.addEventListener('touchstart', startPan, { capture: true, passive: true })
      surface.addEventListener('touchmove', movePan, { capture: true, passive: false })
      surface.addEventListener('touchend', endPan, true)
      surface.addEventListener('touchcancel', endPan, true)
      disposeTerminal = () => {
        touch = null
        surface.removeEventListener('touchstart', startPan, true)
        surface.removeEventListener('touchmove', movePan, true)
        surface.removeEventListener('touchend', endPan, true)
        surface.removeEventListener('touchcancel', endPan, true)
        term.dispose()
      }
      return term
    }
    let term = createTerminal()
    const view = remote.openTerminal(target, {
      reset: () => {
        disposeTerminal()
        following.current = true
        term = createTerminal()
      },
      write: (bytes) => {
        const renderer = term
        return new Promise((resolve) =>
          renderer.write(bytes, () => {
            // xterm's write callback ends parsing, not painting.
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const viewport = viewportRef.current
                if (
                  viewport &&
                  current &&
                  terminal.current === renderer &&
                  following.current &&
                  term.buffer.active.type === 'normal' &&
                  term.buffer.active.viewportY === term.buffer.active.baseY
                )
                  viewport.scrollTop = Math.max(
                    0,
                    terminalCursorBottom(term) - viewport.clientHeight,
                  )
                resolve()
              }),
            )
          }),
        )
      },
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
      terminal.current = undefined
      current = false
      void view.close()
      disposeTerminal()
    }
  }, [remote, target])
  useEffect(() => {
    fontSizeRef.current = fontSize
    if (terminal.current) terminal.current.options.fontSize = fontSize
  }, [fontSize])

  useEffect(() => {
    if (paste !== null) pastePreview.current?.scrollIntoView({ block: 'nearest' })
  }, [paste])

  const disabled = !ready || sending || composition
  const send = async (
    label: string,
    action: (view: TerminalView) => Promise<InputResult | PasteResult>,
    clearDraft = false,
  ) => {
    const view = viewRef.current
    if (!view || !ready || busy.current || composing.current) return
    busy.current = true
    setSending(true)
    setResult(`${label} · 送信中（受理確認前）…`)
    try {
      const outcome = await action(view)
      if (viewRef.current !== view) return
      const delivery = typeof outcome === 'string' ? outcome : outcome.result
      const progress =
        typeof outcome === 'string'
          ? ''
          : `貼り付け ${outcome.acceptedBytes}/${outcome.totalBytes} bytesを受理。${delivery === 'accepted' ? '' : '残りは停止。'}`
      setResult(progress + deliveryLabels[delivery])
      if (delivery === 'accepted' && clearDraft) setText('')
    } finally {
      busy.current = false
      if (viewRef.current === view) setSending(false)
    }
  }
  const sendDraft = (newline: boolean) => {
    let draft = text
    if (ctrl) {
      if (!/^[a-zA-Z@[\]\\^_?]$/.test(draft)) {
        setResult('Ctrlは英字または @ [ \\ ] ^ _ ? の1文字を入力して送信してください。')
        return
      }
      draft = String.fromCharCode(draft === '?' ? 127 : draft.toUpperCase().charCodeAt(0) & 31)
    }
    const bytes = new TextEncoder().encode(draft + (newline && !ctrl ? '\r' : ''))
    if (bytes.length > 65536) {
      setResult('未送信です。入力は64KiB以内です。長いテキストは貼り付けを使ってください。')
      return
    }
    void send('入力', (view) => view.input(bytes), true)
    setCtrl(false)
  }
  const previewPaste = (value: string) => {
    setPaste(null)
    if (new TextEncoder().encode(value).length > 262144) {
      setResult('未送信です。貼り付けはUTF-8で256KiB以内です。全量を拒否しました。')
    } else if (!value) setResult('貼り付けるテキストがありません。fileや画像は送れません。')
    else setPaste(value)
  }
  const selectOutput = () => {
    if (snapshot !== null) {
      setSnapshot(null)
      return
    }
    const buffer = terminal.current?.buffer.active
    if (!buffer) return
    const lines: string[] = []
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    setSnapshot(lines.join('\n'))
  }
  const labels = {
    waiting: '末尾を読み込み中…',
    viewing: ready ? '閲覧中 · Macと共有入力' : '閲覧中 · Mac renderer待ち（入力不可）',
    exited: 'Terminal Sessionは終了しました',
    closed: '表示接続を解除しました。Macの作業は継続します。',
    'detach-pending': '表示は停止しました。解除確認待ち。',
    unavailable: '切断しました。MacとTailscaleを確認中です。入力は再送しません。',
    background: '背景では表示接続を停止しています。',
    removed: 'Tabは削除されました。',
    replaced: 'Terminal Sessionが置き換わりました。一覧から選び直してください。',
    lost: 'Terminal Sessionを失いました。Macで確認してください。',
    failed: 'Terminal Sessionを起動できませんでした。Macで確認してください。',
    revoked: '登録が失効しました。Macで確認して再登録してください。',
    'approval-required': '承認が必要です。Macで登録を確認してください。',
    'identity-changed': 'Macのidentityを確認してください。',
    incompatible: 'アプリを更新してください。',
  }
  return (
    <section ref={workspace} className="terminal-workspace" aria-label="Terminal Sessionの閲覧">
      <nav aria-label="端末の表示操作" className="terminal-navigation">
        <button onClick={back}>一覧へ戻る · 表示解除</button>
        <button data-select-output aria-pressed={snapshot !== null} onClick={selectOutput}>
          選択・コピー
        </button>
        <button
          data-zoom-in
          aria-label="端末文字を拡大"
          disabled={fontSize >= 28}
          onClick={() => setFontSize((size) => Math.min(28, size + 2))}
        >
          A＋
        </button>
        <button
          aria-label="端末文字を縮小"
          disabled={fontSize <= 10}
          onClick={() => setFontSize((size) => Math.max(10, size - 2))}
        >
          A−
        </button>
      </nav>
      <p className="terminal-state" role="status" aria-live="polite">
        {labels[state]}
      </p>
      <div
        ref={viewportRef}
        className="terminal-viewport"
        aria-label="Macの固定サイズの端末出力"
        onScroll={(event) => {
          const term = terminal.current
          const viewport = event.currentTarget
          if (term)
            following.current =
              term.buffer.active.viewportY === term.buffer.active.baseY &&
              viewport.scrollTop + viewport.clientHeight >= terminalCursorBottom(term) - 1
        }}
      >
        <div ref={container} hidden={snapshot !== null} />
        {snapshot !== null && (
          <textarea
            data-output-text
            ref={selection}
            aria-label="選択する端末出力（表示時点のテキスト）"
            readOnly
            value={snapshot}
            wrap="off"
          />
        )}
      </div>
      {snapshot !== null && (
        <div className="terminal-selection">
          <span>表示時点のテキスト。長押しで選択できます。</span>
          <button
            data-copy-output
            onClick={async () => {
              const field = selection.current
              if (!field) return
              const value =
                field.selectionStart === field.selectionEnd
                  ? snapshot
                  : snapshot.slice(field.selectionStart, field.selectionEnd)
              try {
                await writeClipboardText(value)
                setResult('テキストをコピーしました。')
              } catch {
                setResult('コピーできませんでした。選択範囲を小さくしてください。')
              }
            }}
          >
            選択範囲をコピー（未選択なら全体）
          </button>
        </div>
      )}
      <div className="terminal-controls">
        <div className="terminal-keys" role="group" aria-label="端末の補助キー">
          <button
            aria-label="Ctrl"
            aria-pressed={ctrl}
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCtrl((value) => !value)}
          >
            Ctrl
          </button>
          {keys.map((key) => (
            <button
              key={key.name}
              aria-label={key.name}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setCtrl(false)
                const bytes =
                  'cursor' in key
                    ? `\x1b${terminal.current?.modes.applicationCursorKeysMode ? 'O' : '['}${key.cursor}`
                    : key.bytes
                void send(key.name, (view) => view.input(new TextEncoder().encode(bytes)))
              }}
            >
              {key.text}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            sendDraft(true)
          }}
        >
          <label htmlFor="terminal-draft">
            共有入力{ctrl ? ' · Ctrlの1文字' : ' · 確定後に送信'}
          </label>
          <input
            id="terminal-draft"
            ref={draftRef}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })}
            aria-label="共有Terminal Sessionへの入力"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onCompositionStart={() => {
              composing.current = true
              setComposition(true)
            }}
            onCompositionEnd={() => {
              composing.current = false
              setComposition(false)
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault()
            }}
            onPaste={(event) => {
              event.preventDefault()
              if (disabled) return
              if (event.clipboardData.files.length) {
                setResult('fileや画像は送れません。テキストだけ貼り付けできます。')
                return
              }
              previewPaste(event.clipboardData.getData('text/plain'))
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={!ready || sending}
          />
          <div className="terminal-send-actions">
            <button type="submit" disabled={disabled}>
              {sending ? '送信中…' : ctrl ? 'Ctrl文字を送信' : '送信（改行）'}
            </button>
            <button
              type="button"
              data-send-text
              disabled={disabled || !text}
              onClick={() => sendDraft(false)}
            >
              文字だけ送信
            </button>
            <button
              type="button"
              data-paste
              disabled={disabled}
              onClick={async () => {
                const view = viewRef.current
                try {
                  const value = await readClipboardText()
                  if (viewRef.current === view) previewPaste(value)
                } catch {
                  setResult('テキストを読み取れませんでした。貼り付け許可を確認してください。')
                }
              }}
            >
              貼り付け…
            </button>
          </div>
        </form>
        {paste !== null && (
          <div
            ref={pastePreview}
            className="terminal-paste"
            role="group"
            aria-label="貼り付けの確認"
          >
            <p>
              UTF-8 {new TextEncoder().encode(paste).length}{' '}
              bytes。改行はコマンドを実行する場合があります。
            </p>
            <textarea aria-label="貼り付けるテキスト" readOnly value={paste} />
            <button
              data-confirm-paste
              disabled={disabled}
              onClick={() => {
                const value = paste
                setPaste(null)
                void send('貼り付け', (view) => view.paste(value))
              }}
            >
              貼り付けを送信
            </button>
            <button onClick={() => setPaste(null)}>キャンセル</button>
          </div>
        )}
        <p className="terminal-delivery" role="status" aria-live="polite">
          {result || '押下の反応とMacの受理は別です。自動再送しません。'}
        </p>
        <details>
          <summary>共有入力・表示の制限</summary>
          <p>
            入力はMacと共有され、同時操作で混ざります。入力欄の変換・削除は送信前の下書きです。補助キーは直接送信します。
          </p>
          <p>
            保持された末尾だけを表示します。完全な履歴やTUI画面の復元は保証しません。サイズはMacが決めます。横移動と文字倍率は表示だけを変えます。TUIの履歴は保存されません。
          </p>
          <p>
            受理は実行成功ではありません。送達不明・一部貼り付けは残りを止め、再送しません。失効前に受理した入力は取り消せません。過去の未回答queryを待つTUIは接続だけでは回復しない場合があります。
          </p>
        </details>
      </div>
    </section>
  )
}
