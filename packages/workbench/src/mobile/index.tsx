import { useEffect, useRef, useState } from 'react'

import {
  registerCandidate,
  nativeTransport,
  observeRegistration,
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
const labels = {
  waiting: '接続待ち',
  available: '利用可能',
  unavailable: '利用不可。MacとTailscaleの接続を確認してください。',
  'approval-required': '承認が必要です。Macで登録を確認してください。',
  'identity-changed':
    'Macのidentityが変更されたか、証明書が期限切れです。Macで確認して再登録してください。',
  incompatible: '互換性がありません。MacとiPhoneのアプリを更新してください。',
}

export function MobileWorkbench() {
  const [registration, setRegistration] = useState<RegistrationState>('unregistered')
  const [state, setState] = useState<RemoteState>({ state: 'waiting' })
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState<TerminalTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [scanError, setScanError] = useState<string | null>(null)
  const stopObservation = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    let stop: (() => void) | undefined
    const stopRegistration = observeRegistration(
      (result) => {
        setRegistration(result)
        stop?.()
        if (result === 'approved')
          stop = remote.observe((next) => {
            setState(next)
            setTarget((current) => {
              if (!current || next.state !== 'available') return null
              const tab = next.layout.runspaces
                .flatMap((runspace) => runspace.tabs)
                .find((item) => item.id === current.tabId)
              return tab && tab.terminalSessionId !== current.terminalSessionId ? null : current
            })
          })
        else setState({ state: 'approval-required' })
      },
      (error) => setState({ state: error.state }),
    )
    const cleanup = () => {
      stopRegistration()
      stop?.()
    }
    stopObservation.current = cleanup
    return cleanup
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Explicit reconnect replaces the observation and its generation.
  }, [revision])

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
      setTarget(null)
      stopObservation.current?.()
      setState({ state: 'waiting' })
      await registerCandidate()
    } catch (error) {
      const failure = error instanceof RemoteError ? error.state : 'unavailable'
      setScanError(`QRの登録を完了できませんでした。${labels[failure]}`)
      if (replacing) setState({ state: failure })
    } finally {
      if (replacing) setRevision((value) => value + 1)
      setBusy(false)
    }
  }

  return (
    <main>
      <header>
        <h1>Workbench</h1>
        <p role="status" aria-live="polite">
          {labels[state.state]}
        </p>
      </header>
      <section aria-label="Macの登録">
        <button
          disabled={busy}
          onClick={() => {
            void scan()
          }}
        >
          {busy ? '読み取り中…' : 'Macの登録QRを読み取る'}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setTarget(null)
            setRevision((value) => value + 1)
          }}
        >
          再接続
        </button>
        {scanError && <p role="alert">{scanError}</p>}
        {registration === 'pending' && (
          <p role="status">承認待ち。Macに表示された端末名と接続元を確認して承認してください。</p>
        )}
        {registration === 'rejected' && (
          <p role="alert">登録が拒否されました。Macで新しい招待を作ってください。</p>
        )}
        {registration === 'expired' && (
          <p role="alert">登録の期限が切れました。Macで新しい招待を作ってください。</p>
        )}
      </section>
      {target && <TerminalOutput remote={remote} target={target} back={() => setTarget(null)} />}
      {state.state === 'available' && (
        <section aria-label="Runspace一覧">
          {state.layout.runspaces.length === 0 && (
            <p>Runspaceはありません。Macで開いた作業がここに表示されます。</p>
          )}
          {state.layout.runspaces.map((runspace) => (
            <article key={runspace.id}>
              <h2>{runspace.cwd}</h2>
              <ul>
                {runspace.tabs.map((tab) => {
                  const terminal = state.terminalSessions.find(
                    (item) => item.id === tab.terminalSessionId,
                  )
                  const agents = state.agentSessions.filter(
                    (item) => item.terminalSessionId === tab.terminalSessionId,
                  )
                  return (
                    <li key={tab.id}>
                      <button
                        aria-pressed={selected === tab.id}
                        onClick={() => {
                          setSelected(tab.id)
                          setTarget({ tabId: tab.id, terminalSessionId: tab.terminalSessionId })
                        }}
                      >
                        {tab.cwd}
                        {tab.pinned ? ' · Pin' : ''}
                      </button>
                      <p>Terminal Session · {terminal?.status ?? '未観測'}</p>
                      {agents.map((agent) => (
                        <p key={agent.sessionId}>
                          Agent Session · {agent.sessionId} · {agent.state}
                          {agent.unread ? ' · 未読' : ''}
                        </p>
                      ))}
                    </li>
                  )
                })}
              </ul>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
