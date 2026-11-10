import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const shellZdotdirOf = (home: string) => join(home, 'shell/study/zdotdir')

// 非 login の対話の zsh（monica study shell）はこの 2 つだけを読む。
const STARTUP_FILES = ['.zshenv', '.zshrc'] as const

export function writeShellFiles(home: string) {
  const dir = shellZdotdirOf(home)
  mkdirSync(dir, { recursive: true })
  for (const file of STARTUP_FILES) writeIfChanged(join(dir, file), shim(file))
}

function writeIfChanged(path: string, content: string) {
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // まだ無い。
  }
  if (current !== content) writeFileSync(path, content)
}

// zsh は startup file を読むたびに ZDOTDIR を引き直すので、ユーザーのファイルを読む間だけ ZDOTDIR をユーザーの値にする。
function shim(file: (typeof STARTUP_FILES)[number]): string {
  const lines = [
    '# monica study shell の shim。ユーザーの ZDOTDIR にある同じ名前のファイルを読む。',
    '_monica_shim=$ZDOTDIR',
    'ZDOTDIR=${_monica_user_zdotdir:-${MONICA_USER_ZDOTDIR:-$HOME}}',
    `[[ -r $ZDOTDIR/${file} ]] && builtin source -- $ZDOTDIR/${file}`,
    '_monica_user_zdotdir=${ZDOTDIR:-$HOME}',
    'ZDOTDIR=$_monica_shim',
  ]
  if (file === '.zshrc') {
    lines.push(
      // ユーザーの rc の後に読むので、env.sh が足した PATH が前に来る。
      '[[ -f $MONICA_STUDY_DIR/env/env.sh ]] && builtin source -- $MONICA_STUDY_DIR/env/env.sh',
      'if [[ -n $MONICA_USER_ZDOTDIR || $_monica_user_zdotdir != "$HOME" ]]; then',
      '  export ZDOTDIR=$_monica_user_zdotdir',
      'else',
      '  unset ZDOTDIR',
      'fi',
      'unset _monica_shim _monica_user_zdotdir',
    )
  }
  return `${lines.join('\n')}\n`
}
