import { ChevronRightIcon, PinIcon, PromptIcon } from '@monica/ui'
import { useEffect, useRef, useState } from 'react'

import { QrIcon, RefreshIcon } from './icons.tsx'
import {
  registerCandidate,
  nativeTransport,
  observeRegistration,
  observeForeground,
  scanRegistration,
  type RegistrationState,
} from './native.ts'
import {
  RemoteError,
  RemoteWorkbench,
  type RemoteState,
  type TerminalTarget,
} from './remote-workbench.ts'
import { TerminalOutput } from './terminal.tsx'

export { RemoteWorkbench, RemoteError } from './remote-workbench.ts'
export type { RemoteState, RemoteTransport } from './remote-workbench.ts'

const remote = new RemoteWorkbench(nativeTransport)
type Tone = 'ok' | 'pending' | 'warn' | 'error'
type Copy = { title: string; detail: string; tone: Tone }
const states: Record<RemoteState['state'], Copy> = {
  waiting: { title: '接続中', detail: 'Macに接続しています。', tone: 'pending' },
  background: { title: '一時停止', detail: '背景では接続を停止しています。', tone: 'pending' },
  revoked: {
    title: '登録が失効しました',
    detail: 'Macで確認し、新しいQRで登録し直してください。',
    tone: 'error',
  },
  available: { title: '接続済み', detail: '', tone: 'ok' },
  unavailable: {
    title: 'Macに接続できません',
    detail: 'MacとTailscaleの接続を確認してください。自動で再試行します。',
    tone: 'warn',
  },
  'approval-required': {
    title: '承認待ち',
    detail: 'Macで登録を確認してください。',
    tone: 'warn',
  },
  'identity-changed': {
    title: 'Macの証明書が変わりました',
    detail: 'identityが変更されたか、期限が切れています。Macで確認して再登録してください。',
    tone: 'error',
  },
  incompatible: {
    title: '更新が必要です',
    detail: 'MacとiPhoneのアプリを更新してください。',
    tone: 'error',
  },
}
const registrations: Partial<Record<RegistrationState, Copy>> = {
  unregistered: {
    title: 'Macを登録',
    detail: 'MacのWorkbenchでRemote accessを開き、表示されたQRを読み取ってください。',
    tone: 'pending',
  },
  pending: {
    title: '承認待ち',
    detail: 'Macに表示された端末名と接続元を確かめて承認してください。',
    tone: 'warn',
  },
  rejected: {
    title: '登録が拒否されました',
    detail: 'Macで新しい招待を作ってください。',
    tone: 'error',
  },
  expired: {
    title: '登録の期限が切れました',
    detail: 'Macで新しい招待を作ってください。',
    tone: 'error',
  },
}
const terminalStatuses: Record<string, [string, Tone]> = {
  starting: ['起動中', 'pending'],
  running: ['実行中', 'ok'],
  exited: ['終了', 'pending'],
  lost: ['消失', 'error'],
  failed: ['起動失敗', 'error'],
}
const waitReasons: Record<string, [string, Tone]> = {
  idle: ['手空き', 'pending'],
  question: ['質問', 'warn'],
  permission: ['許可待ち', 'warn'],
  error: ['エラー', 'error'],
}

function baseName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}

function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

export function MobileWorkbench() {
  const [foreground, setForeground] = useState(false)
  const [registration, setRegistration] = useState<RegistrationState>('unregistered')
  const [state, setState] = useState<RemoteState>({ state: 'waiting' })
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState<{ target: TerminalTarget; title: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [scanError, setScanError] = useState<string | null>(null)
  const blocked = useRef(false)
  const stopObservation = useRef<(() => void) | undefined>(undefined)

  useEffect(
    () =>
      observeForeground((active) => {
        remote.setForeground(active)
        setForeground(active)
      }),
    [],
  )

  useEffect(() => {
    if (!foreground || blocked.current) return
    let stop: (() => void) | undefined
    const stopRegistration = observeRegistration(
      (result) => {
        setRegistration(result)
        stop?.()
        if (result === 'approved')
          stop = remote.observe((next) => {
            blocked.current = !['available', 'waiting', 'background', 'unavailable'].includes(
              next.state,
            )
            setState(next)
          })
        else setState({ state: 'approval-required' })
      },
      (error) => {
        blocked.current = error.state !== 'unavailable'
        setState({ state: error.state })
      },
    )
    const cleanup = () => {
      stopRegistration()
      stop?.()
    }
    stopObservation.current = cleanup
    return cleanup
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit reconnect replaces the observation and its generation.
  }, [revision, foreground])

  const scan = async () => {
    setBusy(true)
    setScanError(null)
    let replacing = false
    try {
      const result = await scanRegistration()
      if (result === 'cancelled') return
      if (result === 'expired') {
        setScanError('招待の期限が切れました。Macで新しい招待を作ってください。')
        return
      }
      replacing = true
      blocked.current = false
      setTarget(null)
      stopObservation.current?.()
      setState({ state: 'waiting' })
      await registerCandidate()
    } catch (error) {
      const failure = error instanceof RemoteError ? error.state : 'unavailable'
      setScanError(`QRの登録を完了できませんでした。${states[failure].detail}`)
      if (replacing) setState({ state: failure })
    } finally {
      if (replacing) setRevision((value) => value + 1)
      setBusy(false)
    }
  }

  const copy =
    state.state === 'approval-required' && registration !== 'approved'
      ? (registrations[registration] ?? states[state.state])
      : states[state.state]
  const reconnect = () => {
    blocked.current = false
    setTarget(null)
    setRevision((value) => value + 1)
  }
  const scanButton = (
    <button
      className={state.state === 'available' ? 'button secondary' : 'button primary'}
      disabled={busy}
      onClick={() => {
        void scan()
      }}
    >
      <QrIcon />
      {busy ? '読み取り中…' : state.state === 'available' ? '別のMacを登録' : 'QRを読み取って登録'}
    </button>
  )

  return (
    <main>
      {target && (
        <TerminalOutput
          key={`${target.target.tabId}:${target.target.terminalSessionId}`}
          remote={remote}
          target={target.target}
          title={target.title}
          back={() => setTarget(null)}
        />
      )}
      <header className="app-header">
        <h1>Workbench</h1>
        <button className="icon-button" aria-label="再接続" disabled={busy} onClick={reconnect}>
          <RefreshIcon />
        </button>
        <p className="connection" data-tone={copy.tone} role="status" aria-live="polite">
          {copy.title}
        </p>
      </header>
      {scanError && (
        <p className="banner" data-tone="error" role="alert">
          {scanError}
        </p>
      )}
      {state.state === 'available' ? (
        <>
          <section className="runspaces" aria-label="Runspace一覧">
            {state.layout.runspaces.length === 0 && (
              <p className="empty">Macで開いたRunspaceがここに並びます。</p>
            )}
            {state.layout.runspaces.map((runspace) => (
              <article key={runspace.id} className="group">
                <h2>
                  <span className="group-name">{baseName(runspace.cwd)}</span>
                  <span className="group-path">{homeRelative(runspace.cwd)}</span>
                </h2>
                <ul>
                  {runspace.tabs.map((tab) => {
                    const terminal = state.terminalSessions.find(
                      (item) => item.id === tab.terminalSessionId,
                    )
                    const [status, tone] = (terminal && terminalStatuses[terminal.status]) ?? [
                      '未観測',
                      'pending',
                    ]
                    const agents = state.agentSessions.filter(
                      (item) =>
                        item.terminalSessionId === tab.terminalSessionId && item.state !== 'ended',
                    )
                    const title = baseName(tab.cwd)
                    return (
                      <li key={tab.id}>
                        <button
                          className="row"
                          aria-current={selected === tab.id || undefined}
                          onClick={() => {
                            setSelected(tab.id)
                            setTarget({
                              target: { tabId: tab.id, terminalSessionId: tab.terminalSessionId },
                              title,
                            })
                          }}
                        >
                          <span className="dot" data-tone={tone} title={status} />
                          <span className="row-text">
                            <span className="row-title">
                              {title}
                              {tab.pinned && <PinIcon size={14} aria-label="Pin" />}
                            </span>
                            <span className="row-meta">
                              <span>{status}</span>
                              {agents.map((agent) => {
                                const [label, agentTone] =
                                  agent.state === 'waiting'
                                    ? (waitReasons[agent.waitReason ?? ''] ?? ['待機', 'warn'])
                                    : agent.state === 'running'
                                      ? ['動作中', 'ok']
                                      : ['未観測', 'pending']
                                return (
                                  <span
                                    key={agent.sessionId}
                                    className="chip"
                                    data-tone={agentTone}
                                    data-unread={agent.unread || undefined}
                                  >
                                    Agent {label}
                                    {agent.unread && (
                                      <span className="visually-hidden">・未読</span>
                                    )}
                                  </span>
                                )
                              })}
                            </span>
                          </span>
                          <ChevronRightIcon size={18} className="chevron" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </article>
            ))}
          </section>
          <section className="registration-footer" aria-label="Macの登録">
            {scanButton}
          </section>
        </>
      ) : (
        <section className="onboarding" aria-label="Macの登録" data-tone={copy.tone}>
          <div className="onboarding-mark" aria-hidden="true">
            <PromptIcon size={34} />
          </div>
          <h2>{copy.title}</h2>
          <p>{copy.detail}</p>
          <div className="onboarding-actions">
            {scanButton}
            <button className="button secondary" disabled={busy} onClick={reconnect}>
              <RefreshIcon size={18} />
              再接続
            </button>
          </div>
        </section>
      )}
    </main>
  )
}
