import { Terminal } from '@xterm/xterm'
import { type MouseEvent, useEffect, useRef, useState } from 'react'

import type { InputResult } from '../remote-terminal.ts'
import { renderFlow } from './flow.ts'
import { ChevronLeftIcon, ClipboardIcon, SelectTextIcon, SendIcon, WrapIcon } from './icons.tsx'
import { readClipboardText, writeClipboardText } from './native.ts'
import type {
  RemoteWorkbench,
  PasteResult,
  TerminalDisplay,
  TerminalTarget,
  TerminalView,
} from './remote-workbench.ts'

import '@xterm/xterm/css/xterm.css'

type Tone = 'ok' | 'pending' | 'warn' | 'error'
const deliveryLabels = {
  'not-sent': ['未送信です。接続とMacの状態を確認してください。', 'warn'],
  uncertain: ['送達不明です。自動再送しないので、出力を確認してから操作してください。', 'error'],
} as const
const keys = [
  { name: 'Esc', text: 'esc', bytes: '\x1b' },
  { name: 'Tab', text: 'tab', bytes: '\t' },
  { name: '左矢印', text: '←', cursor: 'D' },
  { name: '上矢印', text: '↑', cursor: 'A' },
  { name: '下矢印', text: '↓', cursor: 'B' },
  { name: '右矢印', text: '→', cursor: 'C' },
  { name: '削除', text: '⌫', bytes: '\x7f' },
  { name: 'Enter', text: '↵', bytes: '\r' },
]

// Keeps the software keyboard up while a key or button is tapped.
function keyPress(event: MouseEvent) {
  event.preventDefault()
}

function terminalCursorBottom(term: Terminal): number {
  return ((term.element?.clientHeight ?? 0) * (term.buffer.active.cursorY + 1)) / term.rows
}

export function TerminalOutput({
  remote,
  target,
  title,
  back,
}: {
  remote: RemoteWorkbench
  target: TerminalTarget
  title: string
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
  const [result, setNotice] = useState<{ text: string; tone: Tone } | null>(null)
  const setResult = (message: string, tone: Tone = 'warn') => setNotice({ text: message, tone })
  const [paste, setPaste] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [fontSize, setFontSize] = useState(14)
  const fontSizeRef = useRef(14)
  const [fit, setFit] = useState(true)
  const fitRef = useRef(true)
  // The Mac owns the PTY grid, so only the font shrinks, and never below a readable size.
  const fitWidth = () => {
    const term = terminal.current
    const viewport = viewportRef.current
    const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!fitRef.current || !term || !viewport || !screen?.offsetWidth) return
    const widthPerPx = screen.offsetWidth / (term.options.fontSize ?? fontSizeRef.current)
    const size = Math.floor(((viewport.clientWidth - 6) / widthPerPx) * 2) / 2
    setFontSize(Math.min(28, Math.max(11, size)))
  }
  const [wrap, setWrap] = useState(true)
  const [alt, setAlt] = useState(false)
  const [flowFont, setFlowFont] = useState(13)
  const showFlow = wrap && !alt
  const flowRef = useRef<HTMLDivElement>(null)
  const flowFollowing = useRef(true)
  const flowHtml = useRef('')
  const flowFrame = useRef(0)
  const flowPending = useRef(false)
  const scheduleFlow = () => {
    if (flowFrame.current) return
    flowFrame.current = requestAnimationFrame(() => {
      flowFrame.current = 0
      const flow = flowRef.current
      const buffer = terminal.current?.buffer.active
      if (!flow || buffer?.type !== 'normal') return
      // Replacing the markup would drop a selection the reader is making.
      const selected = document.getSelection()
      if (selected && !selected.isCollapsed && flow.contains(selected.anchorNode)) {
        flowPending.current = true
        return
      }
      const html = renderFlow(buffer)
      if (html === flowHtml.current) return
      flowHtml.current = html
      flow.innerHTML = html
      if (flowFollowing.current) flow.scrollTop = flow.scrollHeight
    })
  }
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
        fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        allowProposedApi: true,
      })
      term.parser.registerOscHandler(52, () => true)
      term.parser.registerOscHandler(1337, () => true)
      term.attachCustomKeyEventHandler(() => false)
      term.open(surface)
      terminal.current = term
      term.buffer.onBufferChange((buffer) => {
        if (current) setAlt(buffer.type === 'alternate')
        scheduleFlow()
      })
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
        flowFollowing.current = true
        term = createTerminal()
        setAlt(false)
        scheduleFlow()
      },
      write: (bytes) => {
        const renderer = term
        return new Promise((resolve) =>
          renderer.write(bytes, () => {
            if (current && terminal.current === renderer) scheduleFlow()
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
      size: (rows, cols) => {
        term.resize(cols, rows)
        requestAnimationFrame(fitWidth)
        scheduleFlow()
      },
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- fitWidth and scheduleFlow read only refs, so a new render must not reopen the view.
  }, [remote, target])
  useEffect(() => {
    fontSizeRef.current = fontSize
    if (terminal.current) terminal.current.options.fontSize = fontSize
  }, [fontSize])
  useEffect(() => {
    fitRef.current = fit
    const viewport = viewportRef.current
    if (!fit || !viewport) return
    const observer = new ResizeObserver(() => fitWidth())
    observer.observe(viewport)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- fitWidth reads only refs.
  }, [fit])
  useEffect(() => {
    if (!showFlow) return
    flowHtml.current = ''
    flowFollowing.current = true
    scheduleFlow()
    const resume = () => {
      if (flowPending.current && document.getSelection()?.isCollapsed !== false) {
        flowPending.current = false
        scheduleFlow()
      }
    }
    document.addEventListener('selectionchange', resume)
    return () => document.removeEventListener('selectionchange', resume)
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- scheduleFlow reads only refs.
  }, [showFlow])
  const zoom = (step: number) => {
    if (showFlow) {
      setFlowFont((size) => Math.min(24, Math.max(9, size + step)))
      return
    }
    setFit(false)
    setFontSize((size) => Math.min(28, Math.max(4, Math.round(size) + step)))
  }

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
    setNotice(null)
    try {
      const outcome = await action(view)
      if (viewRef.current !== view) return
      const delivery = typeof outcome === 'string' ? outcome : outcome.result
      const progress =
        typeof outcome === 'string'
          ? ''
          : `貼り付け ${outcome.acceptedBytes}/${outcome.totalBytes} bytesを受理。${delivery === 'accepted' ? '' : '残りは停止。'}`
      if (delivery === 'accepted') {
        if (clearDraft) setText('')
        return
      }
      const [message, tone] = deliveryLabels[delivery]
      setResult(progress + message, tone)
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
  const labels: Record<typeof state, [string, Tone]> = {
    waiting: ['末尾を読み込み中…', 'pending'],
    viewing: ready ? ['閲覧中 · 入力可', 'ok'] : ['閲覧中 · 準備待ち', 'pending'],
    exited: ['Terminal Sessionは終了しました', 'pending'],
    closed: ['表示を解除しました。Macの作業は続いています。', 'pending'],
    'detach-pending': ['表示を止めました。解除の確認を待っています。', 'pending'],
    unavailable: ['切断しました。MacとTailscaleを確認中です。入力は再送しません。', 'warn'],
    background: ['背景では表示接続を停止しています。', 'pending'],
    removed: ['Tabは削除されました。', 'error'],
    replaced: ['Terminal Sessionが置き換わりました。一覧から選び直してください。', 'warn'],
    lost: ['Terminal Sessionを失いました。Macで確認してください。', 'error'],
    failed: ['Terminal Sessionを起動できませんでした。Macで確認してください。', 'error'],
    revoked: ['登録が失効しました。Macで確認して再登録してください。', 'error'],
    'approval-required': ['承認が必要です。Macで登録を確認してください。', 'warn'],
    'identity-changed': ['Macのidentityを確認してください。', 'error'],
    incompatible: ['アプリを更新してください。', 'error'],
  }
  const [stateLabel, stateTone] = labels[state]
  return (
    <section ref={workspace} className="terminal-workspace" aria-label="Terminal Sessionの閲覧">
      <nav aria-label="端末の表示操作" className="terminal-bar">
        <button className="bar-back" aria-label="一覧へ戻る（表示を解除）" onClick={back}>
          <ChevronLeftIcon size={22} />
          一覧
        </button>
        <div className="bar-title">
          <h2>{title}</h2>
          <p className="terminal-state" data-tone={stateTone} role="status" aria-live="polite">
            {stateLabel}
          </p>
        </div>
        <div className="bar-tools">
          {!showFlow && (
            <button
              className="icon-button"
              data-select-output
              aria-label="出力を選択してコピー"
              aria-pressed={snapshot !== null}
              onClick={selectOutput}
            >
              <SelectTextIcon />
            </button>
          )}
          <div className="zoom" role="group" aria-label="端末の文字の大きさ">
            <button
              aria-label="端末文字を縮小"
              disabled={showFlow ? flowFont <= 9 : fontSize <= 4}
              onClick={() => zoom(-2)}
            >
              <small>A</small>
            </button>
            <button
              data-wrap
              aria-label={alt ? '全画面の表示中は折り返せません' : '画面の幅で折り返す'}
              aria-pressed={showFlow}
              disabled={alt}
              onClick={() => {
                setWrap((value) => !value)
                setFit(true)
                setSnapshot(null)
              }}
            >
              <WrapIcon size={18} />
            </button>
            <button
              data-zoom-in
              aria-label="端末文字を拡大"
              disabled={showFlow ? flowFont >= 24 : fontSize >= 28}
              onClick={() => zoom(2)}
            >
              A
            </button>
          </div>
        </div>
      </nav>
      {showFlow && (
        <div
          ref={flowRef}
          className="terminal-flow"
          role="region"
          aria-label="端末の出力（画面の幅で折り返し）"
          style={{ fontSize: flowFont }}
          onScroll={(event) => {
            const flow = event.currentTarget
            flowFollowing.current = flow.scrollTop + flow.clientHeight >= flow.scrollHeight - 8
          }}
        />
      )}
      <div
        ref={viewportRef}
        className={showFlow ? 'terminal-viewport is-hidden' : 'terminal-viewport'}
        aria-hidden={showFlow || undefined}
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
      <div className="terminal-controls">
        {snapshot !== null ? (
          <div className="terminal-selection">
            <p>表示時点のテキストです。長押しで範囲を選べます。</p>
            <div className="actions">
              <button className="button secondary" onClick={() => setSnapshot(null)}>
                閉じる
              </button>
              <button
                className="button primary"
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
                    setResult('テキストをコピーしました。', 'ok')
                  } catch {
                    setResult('コピーできませんでした。選択範囲を小さくしてください。')
                  }
                }}
              >
                コピー（未選択なら全体）
              </button>
            </div>
          </div>
        ) : (
          <div className="terminal-keys" role="group" aria-label="端末の補助キー">
            <button
              className="key"
              aria-label="Ctrl"
              aria-pressed={ctrl}
              disabled={disabled}
              onMouseDown={keyPress}
              onClick={() => setCtrl((value) => !value)}
            >
              ctrl
            </button>
            {keys.map((key) => (
              <button
                key={key.name}
                className="key"
                aria-label={key.name}
                disabled={disabled}
                onMouseDown={keyPress}
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
        )}
        {paste !== null && (
          <div
            ref={pastePreview}
            className="terminal-paste"
            role="group"
            aria-label="貼り付けの確認"
          >
            <p>
              <strong>{new TextEncoder().encode(paste).length.toLocaleString()} bytes</strong>
              を貼り付けます。改行はコマンドを実行することがあります。
            </p>
            <textarea aria-label="貼り付けるテキスト" readOnly value={paste} />
            <div className="actions">
              <button className="button secondary" onClick={() => setPaste(null)}>
                キャンセル
              </button>
              <button
                className="button primary"
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
            </div>
          </div>
        )}
        <form
          className="composer"
          data-ctrl={ctrl || undefined}
          onSubmit={(event) => {
            event.preventDefault()
            sendDraft(true)
          }}
        >
          <button
            type="button"
            className="composer-paste"
            data-paste
            aria-label="クリップボードを貼り付け"
            disabled={disabled}
            onMouseDown={keyPress}
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
            <ClipboardIcon size={19} />
          </button>
          {ctrl && <span className="composer-mode">ctrl</span>}
          <input
            id="terminal-draft"
            ref={draftRef}
            placeholder={ctrl ? '1文字（英字か @[\\]^_?）' : 'コマンドを入力'}
            onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest' })}
            aria-label={ctrl ? 'Ctrlと組み合わせる1文字' : '共有Terminal Sessionへの入力'}
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
            enterKeyHint="send"
            disabled={!ready || sending}
          />
          <button
            type="button"
            className="composer-plain"
            data-send-text
            hidden={!text}
            disabled={disabled || !text}
            onMouseDown={keyPress}
            onClick={() => sendDraft(false)}
          >
            改行なし
          </button>
          <button
            type="submit"
            className="composer-send"
            aria-label={ctrl ? 'Ctrl文字を送信' : '送信（改行）'}
            disabled={disabled}
            onMouseDown={keyPress}
          >
            <SendIcon size={18} />
          </button>
        </form>
        <p className="terminal-delivery" data-tone={result?.tone} role="status" aria-live="polite">
          {result?.text}
        </p>
      </div>
    </section>
  )
}
