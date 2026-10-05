import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const zdotdirOf = (home: string) => join(home, 'shell/zdotdir')
const binOf = (home: string) => join(home, 'bin')
const settingsOf = (home: string) => join(home, 'shell/claude/settings.json')

export function tabEnv(home: string, terminalSessionId: string): [string, string][] {
  return [
    ['TANIA_HOME', home],
    ['TANIA_TERMINAL_SESSION_ID', terminalSessionId],
    ['ZDOTDIR', zdotdirOf(home)],
    ['TANIA_USER_ZDOTDIR', process.env.ZDOTDIR ?? ''],
    ['PATH', [binOf(home), process.env.PATH].filter(Boolean).join(':')],
  ]
}

const STARTUP_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const

export function writeTabFiles(home: string) {
  for (const file of STARTUP_FILES) {
    writeIfChanged(join(zdotdirOf(home), file), shim(home, file))
  }
  writeIfChanged(join(binOf(home), 'claude'), claudeWrapper(home))
  chmodSync(join(binOf(home), 'claude'), 0o755)
  writeIfChanged(settingsOf(home), hookSettings(home))
}

function writeIfChanged(path: string, content: string) {
  let current: string | null = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {
    // まだ無い。
  }
  if (current === content) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// zsh は startup file を読むたびに ZDOTDIR を引き直すので、ユーザーのファイルを読む間だけ ZDOTDIR をユーザーの値にし、
// 読み終えたら shim に戻して次のファイルも shim から読ませる。
function shim(home: string, file: (typeof STARTUP_FILES)[number]): string {
  const lines = [
    '# tania の shim。ユーザーの ZDOTDIR にある同じ名前のファイルを読む。',
    '_tania_shim=$ZDOTDIR',
    'ZDOTDIR=${_tania_user_zdotdir:-${TANIA_USER_ZDOTDIR:-$HOME}}',
    `[[ -r $ZDOTDIR/${file} ]] && builtin source -- $ZDOTDIR/${file}`,
    '_tania_user_zdotdir=${ZDOTDIR:-$HOME}',
    'ZDOTDIR=$_tania_shim',
  ]
  if (file === '.zshrc') {
    // ユーザーの rc が PATH の前に何を足しても、tab の tania と claude はこの home のものを指す。
    const bin = shellQuote(binOf(home))
    lines.push(`path=(${bin} \${path:#${bin}})`)
  }
  if (file === '.zlogin') {
    // tab から起こした子（tmux、dev の desktop、agent の Bash tool）は shim を通らずにユーザーのファイルを読む。
    lines.push(
      'if [[ -n $TANIA_USER_ZDOTDIR || $_tania_user_zdotdir != "$HOME" ]]; then',
      '  export ZDOTDIR=$_tania_user_zdotdir',
      'else',
      '  unset ZDOTDIR',
      'fi',
      'unset _tania_shim _tania_user_zdotdir',
    )
  }
  return `${lines.join('\n')}\n`
}

// claude 2.1.288 の `claude --help` の Commands と、それより前の版にあった config・api-key・migrate-installer。
const CLAUDE_SUBCOMMANDS = [
  'agents',
  'api-key',
  'attach',
  'auth',
  'auto-mode',
  'config',
  'doctor',
  'gateway',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'migrate-installer',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade',
]

// 別の wrapper（他の home の tania や monica）とは互いに PATH の先頭の claude へ戻して exec が巡回しうるので、
// 同じ pid（exec は pid を変えない）で戻ってきたら試した claude を飛ばし、settings も足し直さない。
function claudeWrapper(home: string): string {
  return `#!/bin/bash
# tania の claude wrapper。PATH にある次の claude を exec し、Tab で起こした claude にだけ hook を付ける。
trail=""
[[ "\${TANIA_CLAUDE_TRAIL%%:*}" == "$$" ]] && trail="\${TANIA_CLAUDE_TRAIL#*:}"
real=""
set -f
IFS=:
for dir in $PATH; do
  candidate="\${dir:-.}/claude"
  [[ -x "$candidate" && ! -d "$candidate" ]] || continue
  [[ "$candidate" -ef "$0" || ":$trail:" == *":$candidate:"* ]] && continue
  real="$candidate"
  break
done
unset IFS
set +f
if [[ -z "$real" ]]; then
  echo "tania: no claude on PATH other than $0" >&2
  exit 127
fi
# CLAUDECODE があるのは agent の Bash tool から起こした claude で、hook を付けると親の Agent Session を superseded にする。
hooked=""
[[ -z "$trail" && -n "\${TANIA_TERMINAL_SESSION_ID:-}" && -z "\${CLAUDECODE:-}" ]] && hooked=1
# claude は --settings の後ろの subcommand を prompt として読むので、subcommand には足さない。
case "\${1:-}" in
  ${CLAUDE_SUBCOMMANDS.join('|')}) hooked="" ;;
esac
[[ -n "$hooked" ]] && set -- --settings ${shellQuote(settingsOf(home))} "$@"
export TANIA_CLAUDE_TRAIL="$$:\${trail:+$trail:}$real"
exec "$real" "$@"
`
}

function hookSettings(home: string): string {
  const command = `${shellQuote(join(binOf(home), 'tania'))} workbench hook claude`
  // 既定の timeout は 600 秒で、Backend が固まると claude が 10 分止まる。
  const hook = (matcher?: string) => [
    { ...(matcher && { matcher }), hooks: [{ type: 'command', command, timeout: 5 }] },
  ]
  const hooks = {
    SessionStart: hook(),
    UserPromptSubmit: hook(),
    PreToolUse: hook('AskUserQuestion'),
    PostToolUse: hook(),
    PostToolUseFailure: hook(),
    PermissionRequest: hook(),
    Stop: hook(),
    StopFailure: hook(),
    SessionEnd: hook(),
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
