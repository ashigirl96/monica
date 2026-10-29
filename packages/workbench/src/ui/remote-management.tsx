import { useEffect, useRef, useState } from 'react'

import type { WorkbenchClient } from './store.ts'

type RemoteStatus = Awaited<ReturnType<WorkbenchClient['remote']['status']>>
type Invitation = Awaited<ReturnType<WorkbenchClient['remote']['invite']>>
const button = 'rounded border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50'

export function RemoteManagement({ client }: { client: WorkbenchClient | null }) {
  const [open, setOpen] = useState<WorkbenchClient | null>(null)
  return (
    <>
      <button
        type="button"
        className={`${button} ml-auto shrink-0`}
        onClick={() => setOpen(() => client)}
        disabled={!client}
      >
        Remote access
      </button>
      {open && open === client && <RemoteSettings client={open} onClose={() => setOpen(null)} />}
    </>
  )
}

function RemoteSettings({ client, onClose }: { client: WorkbenchClient; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const mounted = useRef(true)
  const busy = useRef(false)
  const revision = useRef(0)
  const [working, setWorking] = useState(false)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [invitation, setInvitation] = useState<Invitation | null>(null)
  const [address, setAddress] = useState('')
  const [port, setPort] = useState('19443')
  const [error, setError] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      const readRevision = revision.current
      try {
        if (!busy.current) {
          const next = await client.remote.status()
          if (active && readRevision === revision.current) {
            setStatus(next)
            setReadError(null)
          }
        }
      } catch {
        if (active && readRevision === revision.current) {
          setStatus(null)
          setInvitation(null)
          setReadError('Backend に接続できません。再接続後に登録状態を確認してください。')
        }
      }
      if (active) {
        setNow(Date.now())
        timer = setTimeout(() => void refresh(), 1000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client])

  async function act(
    operation: () => Promise<
      Invitation | Awaited<ReturnType<WorkbenchClient['remote']['revoke']>> | void
    >,
  ) {
    if (busy.current) return
    busy.current = true
    revision.current++
    setWorking(true)
    setError(null)
    setInvitation(null)
    try {
      const result = await operation()
      if (!mounted.current) return
      if (result && 'qr' in result) setInvitation(result)
      const next = await client.remote.status()
      if (mounted.current) setStatus(next)
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : '操作に失敗しました')
    } finally {
      busy.current = false
      if (mounted.current) setWorking(false)
    }
  }

  const pending = status?.pending
  const liveInvitation =
    invitation &&
    invitation.expiresAt > now &&
    status?.state === 'listening' &&
    status.invitationExpiresAt === invitation.expiresAt &&
    !status.pending
      ? invitation
      : null
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="remote-title"
      onKeyDown={(event) => event.stopPropagation()}
      className="fixed inset-0 m-auto max-h-[90vh] w-[42rem] max-w-[95vw] overflow-y-auto rounded-xl border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/60"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id="remote-title" className="text-lg font-semibold">
          Remote access
        </h2>
        <button className={button} type="button" onClick={() => dialog.current?.close()}>
          閉じる
        </button>
      </div>
      <p className="mb-4 text-sm">
        許可した端末には Mac ユーザーの shell 権限を与えます。API の制限はコマンドの sandbox
        ではありません。この版は登録と接続確認のみで、一覧と端末操作は公開しません。
      </p>
      <p role="status" className="mb-3 text-sm">
        {working
          ? '処理中…'
          : status
            ? {
                disabled: '無効',
                listening: 'TLS 接続を受付中',
                unavailable: 'Remote を開始できません',
              }[status.state]
            : 'Backend を確認中…'}
      </p>
      {(error || readError || status?.error) && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error ?? readError ?? status?.error}
        </p>
      )}
      {status?.detachPending && (
        <p role="status">拒否済み・解除待ち。Shellの解除完了を確認できていません。</p>
      )}
      <fieldset disabled={working || !status} className="space-y-4 disabled:opacity-60">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void act(() => client.remote.enable({ address, port: Number(port) }))
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Mac の Tailscale address
            <input
              required
              value={address}
              placeholder={status?.settings?.address ?? 'Tailscale IP'}
              onChange={(event) => setAddress(event.target.value)}
              className="rounded border bg-background px-2 py-1.5 select-text"
            />
          </label>
          <label className="flex w-24 flex-col gap-1 text-sm">
            TLS port
            <input
              required
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              className="rounded border bg-background px-2 py-1.5 select-text"
            />
          </label>
          <button type="submit" className={button}>
            有効化
          </button>
          <button
            type="button"
            className={button}
            onClick={() => void act(() => client.remote.disable())}
          >
            無効化
          </button>
        </form>
        {status?.settings && (
          <p className="text-sm select-text">
            接続先 {status.settings.address}:{status.settings.port}
          </p>
        )}
        {status?.identity && (
          <div className="text-xs break-all select-text">
            <p>SHA-256 {status.identity.fingerprint}</p>
            <p>有効期限 {status.identity.expiresAt}</p>
          </div>
        )}
        <p className="text-sm">
          Tailscale grants は指定 iPhone からこの Mac のこの port
          だけに制限し、重なる広い許可も確認してください。Serve、Funnel、LAN、平文や別 port
          への自動切替は使いません。
        </p>
        <button
          type="button"
          className={button}
          disabled={status?.state !== 'listening' || !!status.pending}
          onClick={() => void act(() => client.remote.invite())}
        >
          5 分間の招待 QR を作成
        </button>
        {liveInvitation && (
          <div className="flex flex-col items-center gap-2">
            <img
              src={liveInvitation.qr}
              alt="接続先、TLS identity と一回限りの招待を含む登録 QR"
              className="max-w-full border-[16px] border-white bg-white"
              style={{ imageRendering: 'pixelated' }}
            />
            <p className="text-sm">
              残り {Math.max(0, Math.ceil((liveInvitation.expiresAt - now) / 1000))} 秒。QR
              は共有しないでください。
            </p>
          </div>
        )}
        {pending && (
          <div className="space-y-2 rounded border p-3">
            <p>申請 {pending.name}</p>
            <p className="text-sm select-text">
              TCP source {pending.sourceAddress} / ID {pending.id}
            </p>
            <p className="text-sm">
              自分の iPhone の表示と source address を照合してから承認してください。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className={button}
                onClick={() => void act(() => client.remote.approve({ id: pending.id }))}
              >
                承認
              </button>
              <button
                type="button"
                className={button}
                onClick={() => void act(() => client.remote.reject({ id: pending.id }))}
              >
                拒否
              </button>
            </div>
          </div>
        )}
        <ul className="space-y-2">
          {status?.devices.map((device) => (
            <li
              key={device.id}
              className="flex items-center justify-between gap-3 rounded border p-3"
            >
              <div className="min-w-0 text-sm break-all select-text">
                <p>{device.name}</p>
                <p>
                  {device.sourceAddress} / {device.id}
                </p>
                <p>
                  {device.detachPending
                    ? '拒否済み・解除待ち'
                    : device.revokedAt
                      ? '失効済み'
                      : '登録済み'}
                </p>
              </div>
              {!device.revokedAt && (
                <button
                  type="button"
                  className={button}
                  onClick={() => void act(() => client.remote.revoke({ id: device.id }))}
                >
                  失効
                </button>
              )}
            </li>
          ))}
        </ul>
        <details>
          <summary className="cursor-pointer text-sm">Identity の更新と再登録</summary>
          <p className="my-2 text-sm">
            期限切れや address 変更時は無効化し、全端末を失効させ、identity
            を破棄します。その後、有効化して新しい QR
            で明示的に再登録してください。既に実行したコマンドは取り消せません。
          </p>
          <button
            type="button"
            className={button}
            onClick={() => {
              if (window.confirm('全端末を失効させて TLS identity を破棄しますか？'))
                void act(() => client.remote.renewIdentity())
            }}
          >
            全端末を失効して identity を破棄
          </button>
        </details>
      </fieldset>
    </dialog>
  )
}
