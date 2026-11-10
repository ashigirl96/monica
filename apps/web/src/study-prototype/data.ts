// PROTOTYPE（Study の画面の試作、捨てる）: 偽の Study と、メモリにだけ置く操作。再読み込みで元に戻る。
import { useSyncExternalStore } from 'react'

export type Message =
  | { kind: 'user'; text: string }
  | { kind: 'tutor'; text: string; tutor: string }
  | { kind: 'tool'; text: string; path?: string }
  | { kind: 'tutor-switch'; tutor: string }
  | {
      kind: 'permission'
      id: string
      command: string
      reason: string
      state: 'pending' | 'allowed' | 'denied'
    }

export type Conversation = {
  id: string
  n: number
  startedAt: string
  endedAt?: string
  endedBy?: '新しい会話' | '1 時間の無発言'
  reflection?: string
  messages: Message[]
  thinking?: boolean
}

export type Study = {
  id: string
  short: string
  title: string
  linkedRepos: string[]
  lastActivity: string
  lastActivityLabel: string
  playground: 'ある' | '消えた'
  archived: boolean
  conversations: Conversation[]
  artifacts: Record<string, string>
}

export const REPO_CANDIDATES = [
  'ashigirl96/monica',
  'ashigirl96/dawkinsuke-plugins',
  'oven-sh/bun',
  'unnoq/orpc',
  'TanStack/query',
]

export function missionLine(study: Study): string {
  const first = (study.artifacts['MISSION.md'] ?? '').split('\n').find((l) => l.trim())
  return (first ?? '（Mission はまだ無い）').replace(/^#+\s*/, '')
}

export function missionBody(study: Study): string {
  const lines = (study.artifacts['MISSION.md'] ?? '').split('\n')
  const body = lines.slice(1).find((l) => l.trim() && !l.startsWith('-'))
  return body ?? ''
}

export function activeConversation(study: Study): Conversation | undefined {
  return study.conversations.find((c) => !c.endedAt)
}

export function pendingPermission(study: Study) {
  for (const c of study.conversations) {
    for (const m of c.messages) if (m.kind === 'permission' && m.state === 'pending') return m
  }
  return undefined
}

const ORPC_ARTIFACTS: Record<string, string> = {
  'MISSION.md': `# oRPC が POST の応答で流れを返す仕組みを説明できる

oRPC の event iterator が、POST の応答の body で何をどの形で流しているかを読み、手元の小さな server で再現して、SSE との違いを自分の言葉で説明できるようになる。

- 学習対象: \`unnoq/orpc\` の \`packages/standard-server\` と \`packages/client\`
- 終わりの目安: 「なぜ GET でなく POST で流せるのか」を 3 文で言える
`,
  'RESOURCES.md': `# 一次資料

- [x] [Event Iterator（oRPC の docs）](https://orpc.unnoq.com/docs/event-iterator): 型と使い方
- [x] \`packages/standard-server/src/event-iterator/\`（\`unnoq/orpc\`）: 行の形に符号化する所
- [ ] [HTML Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): \`data:\` と \`event:\` の行の元
- [ ] [Streams Standard](https://streams.spec.whatwg.org/): ReadableStream の背圧

関連: [学習記録 0001](learning-records/0001-post-stream.md)
`,
  'GLOSSARY.md': `# 用語集

**Event Iterator（流れの反復子）**: procedure が \`yield\` で返す値の列。client からは \`for await\` で読む。

**Keepalive（生存の合図）**: 値が無い間も、接続が生きていると伝えるために流す空の行。

**Backpressure（背圧）**: 読む側が遅い時に、書く側を待たせる仕組み。
`,
  'log.md': `# 経過の記録

## 2026-11-05 会話 1
- 一次資料の一覧を作った。docs の Event Iterator を読んだ。
- クイズ「event iterator の値は client で何になるか」: 答えられた。
- 学習記録 [0001](learning-records/0001-post-stream.md) を書いた。

## 2026-11-08 会話 2
- \`standard-server\` の符号化を読んだ。SSE の行の形をそのまま使っていると分かった。
- クイズ「\`EventSource\` で読めない理由」: 半分。POST を送れないことは言えたが、header を足せないことが抜けた。

## 2026-11-10 会話 3（続いている）
- 学習記録 [0002](learning-records/0002-sse-line-format.md) を書いた。
`,
  'learning-records/0001-post-stream.md': `# 0001 oRPC の流れは POST の応答の body で返す

Status: accepted

oRPC は procedure の呼び出しを POST で送り、event iterator の値を、その応答の body に行の形で書き続ける。GET の \`EventSource\` を使わないので、呼び出しの引数を body に載せられる。

- 確かめ方: docs の例を手元で動かし、Network の欄で応答が閉じずに伸びるのを見た。
- 関連: [用語集](../GLOSSARY.md)、[一次資料](../RESOURCES.md)
`,
  'learning-records/0002-sse-line-format.md': `# 0002 流れの 1 つの値は SSE の event 1 つになる

Status: accepted

値は \`event: message\` と \`data: <JSON>\` の行の組で書かれ、空行で区切られる。終わりは \`event: done\`、失敗は \`event: error\`。

\`\`\`text
event: message
data: {"json":{"n":1}}

event: done
data: {"json":null}
\`\`\`

- 関連: [0001](0001-post-stream.md)、[用語集](../GLOSSARY.md)
`,
}

const PERMISSION_COMMAND =
  'docker run --rm -p 8787:8787 -v "$PWD/prototypes/echo:/app" oven/bun:1 bun /app/server.ts'

function orpcStudy(): Study {
  return {
    id: 'study-0193f2a4-7c1e-7b55-9d1a-3f0e2c8b6a10',
    short: '0193f2a4',
    title: 'oRPC の流れ',
    linkedRepos: ['ashigirl96/monica'],
    lastActivity: '2026-11-10T09:48',
    lastActivityLabel: '12 分前',
    playground: 'ある',
    archived: false,
    artifacts: ORPC_ARTIFACTS,
    conversations: [
      {
        id: 'c1',
        n: 1,
        startedAt: '11/5 21:10',
        endedAt: '11/5 22:30',
        endedBy: '1 時間の無発言',
        reflection:
          '一次資料の一覧を作り、docs を 1 つ読んだ。学習記録 0001 を書いた。次は `standard-server` の符号化を読む。',
        messages: [
          { kind: 'user', text: 'oRPC がどうやって stream を返しているのか知りたい' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: 'まず Mission を一緒に決めましょう。「説明できる」の相手は誰を想定しますか。',
          },
          { kind: 'tool', text: 'MISSION.md を書いた', path: 'MISSION.md' },
          { kind: 'tool', text: 'RESOURCES.md を書いた', path: 'RESOURCES.md' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: '一次資料の一覧を作りました。最初は docs の **Event Iterator** の頁を読んでください。読み終えたら教えてください。',
          },
          { kind: 'user', text: '読んだ' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: 'クイズです。procedure が `yield` した値は、client では何として受け取りますか。',
          },
          { kind: 'user', text: 'AsyncIterator で for await で回す' },
          { kind: 'tool', text: 'learning-records/0001-post-stream.md を書いた', path: 'learning-records/0001-post-stream.md' },
        ],
      },
      {
        id: 'c2',
        n: 2,
        startedAt: '11/8 20:02',
        endedAt: '11/8 21:15',
        endedBy: '新しい会話',
        reflection:
          '`standard-server` の符号化を読んだ。クイズは半分。`EventSource` が header を足せないことを次に確かめる。',
        messages: [
          { kind: 'user', text: '前回の続き。符号化の所を読みたい' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: '`packages/standard-server/src/event-iterator/encoder.ts` から読みましょう。`encodeEventMessage` が 1 つの値を行に直します。',
          },
          { kind: 'tool', text: 'RESOURCES.md を書いた（読んだ印）', path: 'RESOURCES.md' },
        ],
      },
      {
        id: 'c3',
        n: 3,
        startedAt: '11/10 9:20',
        messages: [
          { kind: 'user', text: '実際に流れる行を自分の目で見たい' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: 'その前に 1 問。値を 2 つ `yield` して終わる procedure の応答には、`event:` の行が何本出ますか。',
          },
          { kind: 'user', text: 'message が 2 本と done が 1 本で 3 本' },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: '正解です。学習記録に残します。',
          },
          {
            kind: 'tool',
            text: 'learning-records/0002-sse-line-format.md を書いた',
            path: 'learning-records/0002-sse-line-format.md',
          },
          {
            kind: 'tutor',
            tutor: 'repository',
            text: '次は、Playground の container で小さな server を起こし、`curl -N` で行を直に見ます。container は箱の外で走るので、許可をください。',
          },
          {
            kind: 'permission',
            id: 'p1',
            command: PERMISSION_COMMAND,
            reason:
              'Playground の container で event iterator を流す小さな server を起こし、curl で応答の行を見るため。docker は箱の中から走らせられない。',
            state: 'pending',
          },
        ],
      },
    ],
  }
}

function smallStudy(
  fields: Pick<Study, 'id' | 'short' | 'title' | 'linkedRepos' | 'lastActivity' | 'lastActivityLabel' | 'playground' | 'archived'>,
  mission: string,
  reflection: string,
): Study {
  return {
    ...fields,
    artifacts: {
      'MISSION.md': mission,
      'RESOURCES.md': '# 一次資料\n\n- [x] 公式の docs\n- [ ] source の該当箇所\n',
      'GLOSSARY.md': '# 用語集\n\nまだ無い。\n',
      'log.md': `# 経過の記録\n\n## ${fields.lastActivity.slice(0, 10)} 会話 1\n- ${reflection}\n`,
    },
    conversations: [
      {
        id: 'c1',
        n: 1,
        startedAt: fields.lastActivity.slice(5, 10).replace('-', '/'),
        endedAt: fields.lastActivity.slice(5, 10).replace('-', '/'),
        endedBy: '1 時間の無発言',
        reflection,
        messages: [
          { kind: 'user', text: 'はじめたい' },
          { kind: 'tutor', tutor: 'repository', text: 'Mission から決めましょう。' },
          { kind: 'tool', text: 'MISSION.md を書いた', path: 'MISSION.md' },
        ],
      },
    ],
  }
}

function initialStudies(): Study[] {
  return [
    orpcStudy(),
    smallStudy(
      {
        id: 'study-0193e8b0-11aa-7c3d-8e2f-5a6b7c8d9e01',
        short: '0193e8b0',
        title: 'bun の isolated linker',
        linkedRepos: ['ashigirl96/monica'],
        lastActivity: '2026-11-09T22:05',
        lastActivityLabel: '昨日',
        playground: 'ある',
        archived: false,
      },
      '# bun の isolated linker が node_modules をどう組むかを説明できる\n\n`node_modules/.bun` の中の symlink の形を読み、使わなくなった package が残る理由を言えるようになる。\n',
      '`node_modules/.bun` の形を読んだ。消えない package の理由はまだ。',
    ),
    smallStudy(
      {
        id: 'study-0193b1c2-22bb-7d4e-9f30-6b7c8d9e0f12',
        short: '0193b1c2',
        title: 'TanStack Query の cache',
        linkedRepos: [],
        lastActivity: '2026-10-20T19:30',
        lastActivityLabel: '3 週間前',
        playground: 'ある',
        archived: false,
      },
      '# TanStack Query の cache が消える時を言い当てられる\n\n`gcTime` と `staleTime` の違いを、実際の画面の動きで確かめる。\n',
      '`gcTime` の docs を読んだ。Prototype で、画面を閉じてから 5 分後に消えるのを見た。',
    ),
    smallStudy(
      {
        id: 'study-01923a4d-33cc-7e5f-a041-7c8d9e0f1a23',
        short: '01923a4d',
        title: 'Seatbelt の profile',
        linkedRepos: [],
        lastActivity: '2026-07-02T23:10',
        lastActivityLabel: '4 ヶ月前',
        playground: '消えた',
        archived: true,
      },
      '# macOS の Seatbelt の profile を読めるようになる\n\n`sandbox-exec` の profile の書き方を、Agent SDK の sandbox が作る profile を読んで覚える。\n',
      'Agent SDK が作る profile を 1 つ読んだ。`file-read*` の順番の効き方を学習記録に書いた。',
    ),
  ]
}

let studies = initialStudies()
const listeners = new Set<() => void>()

function set(next: Study[]) {
  studies = next
  for (const l of listeners) l()
}

function update(id: string, f: (s: Study) => Study) {
  set(studies.map((s) => (s.id === id ? f(s) : s)))
}

function updateActive(id: string, f: (c: Conversation) => Conversation) {
  update(id, (s) => ({
    ...s,
    conversations: s.conversations.map((c) => (c.endedAt ? c : f(c))),
  }))
}

export function useStudies(): Study[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => studies,
  )
}

export function useStudy(id: string): Study | undefined {
  return useStudies().find((s) => s.id === id || s.short === id)
}

export const actions = {
  send(id: string, text: string) {
    updateActive(id, (c) => ({ ...c, thinking: true, messages: [...c.messages, { kind: 'user', text }] }))
    setTimeout(() => {
      updateActive(id, (c) => ({
        ...c,
        thinking: false,
        messages: [
          ...c.messages,
          {
            kind: 'tutor',
            tutor: 'repository',
            text: `（試作の返事）「${text}」について、一次資料の一覧から次に読む所を選びます。`,
          },
        ],
      }))
    }, 1200)
  },
  answer(id: string, permissionId: string, allow: boolean) {
    updateActive(id, (c) => ({
      ...c,
      messages: [
        ...c.messages.map((m) =>
          m.kind === 'permission' && m.id === permissionId
            ? { ...m, state: allow ? ('allowed' as const) : ('denied' as const) }
            : m,
        ),
        allow
          ? { kind: 'tool', text: '箱の外で docker run を走らせた（port 8787）' }
          : {
              kind: 'tutor',
              tutor: 'repository',
              text: '分かりました。代わりに、`monica study shell` で入って、ご自分で server を起こしてみてください。',
            },
        ...(allow
          ? [
              {
                kind: 'tutor' as const,
                tutor: 'repository',
                text: '起きました。`curl -N -X POST localhost:8787/rpc/count` を手元の端末で打つと、行が 1 本ずつ届くのが見えます。',
              },
            ]
          : []),
      ],
    }))
  },
  newConversation(id: string) {
    update(id, (s) => {
      const n = s.conversations.length + 1
      return {
        ...s,
        conversations: [
          ...s.conversations.map((c) =>
            c.endedAt
              ? c
              : {
                  ...c,
                  endedAt: '11/10 10:01',
                  endedBy: '新しい会話' as const,
                  reflection:
                    '学習記録 0002 を書いた。container の許可は答えが無いまま終わったので、断ったことにした。',
                  messages: c.messages.map((m) =>
                    m.kind === 'permission' && m.state === 'pending' ? { ...m, state: 'denied' as const } : m,
                  ),
                },
          ),
          { id: `c${n}`, n, startedAt: '11/10 10:01', messages: [] },
        ],
      }
    })
  },
  link(id: string, repo: string) {
    update(id, (s) => (s.linkedRepos.includes(repo) ? s : { ...s, linkedRepos: [...s.linkedRepos, repo] }))
  },
  unlink(id: string, repo: string) {
    update(id, (s) => ({ ...s, linkedRepos: s.linkedRepos.filter((r) => r !== repo) }))
  },
  setArchived(id: string, archived: boolean) {
    update(id, (s) => ({ ...s, archived }))
  },
  remove(id: string) {
    set(studies.filter((s) => s.id !== id))
  },
  start(mission: string): string {
    const short = Math.random().toString(16).slice(2, 10)
    const study: Study = {
      id: `study-${short}`,
      short,
      title: mission.slice(0, 16),
      linkedRepos: [],
      lastActivity: '2026-11-10T10:00',
      lastActivityLabel: 'たった今',
      playground: 'ある',
      archived: false,
      artifacts: { 'MISSION.md': `# ${mission}\n` },
      conversations: [{ id: 'c1', n: 1, startedAt: '11/10 10:00', messages: [{ kind: 'user', text: mission }] }],
    }
    set([study, ...studies])
    return short
  },
}
