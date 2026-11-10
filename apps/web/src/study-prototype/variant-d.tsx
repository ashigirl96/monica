// PROTOTYPE（Study の画面の試作、捨てる）: 案 D「組み合わせ」。A・B・C から選んだ部品を組んだもの。
// 左の欄に成果物の木（B）、押すと右の欄に中身（A）。上は A の欄と C の会話の選択。真ん中は A の会話。
// ⌥N で新しい会話の画面に移り、その真ん中に Study の一覧（C）が出る。下に打てば新しい Study を始める。
import { ArrowLeft, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../../../../packages/chat/src/ui/fluid/button.tsx'
import { InputMessage } from '../../../../packages/chat/src/ui/fluid/input-message.tsx'
import { actions, activeConversation, missionLine, type Study } from './data.ts'
import { go, LinkedRepos, ShellCommand, studyHref } from './parts.tsx'
import { ArtifactView, ChatColumn, MoreMenu } from './variant-a.tsx'
import { ArtifactTree } from './variant-b.tsx'
import { ConversationPicker, RecencyList } from './variant-c.tsx'

export function NewChatD() {
  const [draft, setDraft] = useState('')
  return (
    <div className="flex h-dvh flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 pt-16 pb-6">
          <h1 className="mb-1 text-title font-semibold">新しい会話</h1>
          <p className="mb-10 text-caption text-muted-foreground">下に打つと新しい Study を始める。続きなら Study を選ぶ。</p>
          <RecencyList variant="D" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-5">
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={(t) => go(studyHref(`/studies/${actions.start(t)}`, 'D'))}
          placeholder="何を学ぶ？（最初の一言から、Tutor と Mission を決める）"
          sendLabel="始める"
          textareaProps={{ autoFocus: true }}
        />
      </div>
    </div>
  )
}

export function ScreenD({ study }: { study: Study }) {
  const [selected, setSelected] = useState(activeConversation(study)?.id ?? study.conversations.at(-1)!.id)
  const [path, setPath] = useState<string | null>(null)
  const conversation = study.conversations.find((c) => c.id === selected) ?? study.conversations.at(-1)!

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr]">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Button size="icon-sm" variant="ghost" aria-label="新しい会話（⌥N）" title="新しい会話（⌥N）" onClick={() => go(studyHref('/studies', 'D'))}>
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-title font-semibold">{missionLine(study)}</span>
          <div className="flex items-center gap-3">
            <span className="rounded-md bg-muted px-1.5 text-micro text-muted-foreground">Tutor: repository</span>
            <LinkedRepos study={study} compact />
          </div>
        </div>
        <ConversationPicker study={study} selected={conversation} onSelect={setSelected} />
        <div className="w-80">
          <ShellCommand study={study} />
        </div>
        <MoreMenu study={study} after={studyHref('/studies', 'D')} />
      </header>

      <div className={`grid min-h-0 ${path ? 'grid-cols-[15rem_1fr_28rem]' : 'grid-cols-[15rem_1fr]'}`}>
        <nav className="min-h-0 overflow-y-auto border-r border-border p-3">
          <span className="mb-2 block px-2 text-micro text-muted-foreground">成果物</span>
          <ArtifactTree study={study} path={path} onOpen={setPath} />
        </nav>
        <ChatColumn study={study} conversation={conversation} onOpen={setPath} />
        {path && (
          <aside className="flex min-h-0 flex-col border-l border-border">
            <div className="flex items-center justify-between py-1.5 pr-1.5 pl-4">
              <span className="text-micro text-muted-foreground">成果物</span>
              <Button size="icon-sm" variant="ghost" aria-label="閉じる" onClick={() => setPath(null)}>
                <X />
              </Button>
            </div>
            <ArtifactView study={study} path={path} onOpen={setPath} />
          </aside>
        )}
      </div>
    </div>
  )
}
