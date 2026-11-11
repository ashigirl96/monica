import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk'

import { isLocalHost, type Lookup } from './address.ts'

type Verdict = { allow: true } | { allow: false; message: string }

export type AskUser = (
  request: { command: string; description: string | null },
  signal: AbortSignal,
) => Promise<Verdict>

export type TutorBoxDeps = {
  studyDir: string
  tutorDir: string
  learningPreferenceDir: string
  monicaHome: string
  askUser?: AskUser
  /** 振り返りの turn の間は true。Read・Write・Edit のほかを断る。 */
  reflecting?: () => boolean
  nixDaemonSocket?: string
  lookup?: Lookup
}

export type TutorBox = Required<
  Pick<
    Options,
    | 'cwd'
    | 'additionalDirectories'
    | 'tools'
    | 'allowedTools'
    | 'strictMcpConfig'
    | 'permissionMode'
    | 'permissionPrompts'
    | 'canUseTool'
    | 'hooks'
    | 'sandbox'
    | 'settings'
    | 'env'
  >
>

const NIX_DAEMON_SOCKET = '/nix/var/nix/daemon-socket/socket'
// 長い path に向けると claude は /tmp/claude-<uid> に戻る。
const TUTOR_TMPDIR = '/tmp/monica-tutors'

const CANNOT_ASK: Verdict = {
  allow: false,
  message:
    "Running this command outside the box needs the user's permission, and the user cannot be asked yet. Tell the user the command and why it is needed so they can run it themselves.",
}

const ALLOW: Verdict = { allow: true }
const REFLECTION_TOOLS = ['Read', 'Write', 'Edit']
const deny = (message: string): Verdict => ({ allow: false, message })

// Bun の realpath は socket に EOPNOTSUPP を返すので、親の dir を解いてから symlink を自分で辿る。
function realSocketPath(path: string, hops = 0): string | null {
  try {
    const real = join(realpathSync(dirname(path)), basename(path))
    if (!lstatSync(real).isSymbolicLink()) return real
    return hops < 40 ? realSocketPath(resolve(dirname(real), readlinkSync(real)), hops + 1) : null
  } catch {
    return null
  }
}

// まだ無い file は在る一番長い親で解く。行き先の無い symlink は、そこで止まらずに行き先を辿る。
async function nearestRealPath(path: string, hops = 0): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {}
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return hops < 40
        ? nearestRealPath(resolve(dirname(path), await readlink(path)), hops + 1)
        : null
    }
  } catch {}
  const parent = dirname(path)
  if (parent === path) return path
  const real = await nearestRealPath(parent, hops)
  return real && join(real, basename(path))
}

const toResult = (verdict: Verdict): PermissionResult =>
  verdict.allow ? { behavior: 'allow' } : { behavior: 'deny', message: verdict.message }

// glob の記号は .. の字面を書かずに親を指せる（\.\.・[.][.]・.?・@(.)@(.)）ので、点を含む区切りでは * だけを許す。
const climbsOut = (pattern: string) =>
  /^[/~]|\\/.test(pattern) ||
  pattern
    .split('/')
    .some(
      (segment) =>
        segment.includes('.') && (/[^\p{L}\p{N}_.*-]/u.test(segment) || /^[.*]+$/.test(segment)),
    )

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

export function tutorBox(deps: TutorBoxDeps): TutorBox {
  const home = homedir()
  const studyDir = realpathSync(deps.studyDir)
  const tutorDir = realpathSync(deps.tutorDir)
  const learningPreferenceDir = realpathSync(deps.learningPreferenceDir)
  const readable = [studyDir, tutorDir, learningPreferenceDir]
  const writable = [studyDir, learningPreferenceDir]
  const askUser = deps.askUser ?? (async () => CANNOT_ASK)
  const nixSocket = realSocketPath(deps.nixDaemonSocket ?? NIX_DAEMON_SOCKET)
  // 既定の $TMPDIR には、同じ user の他の Claude Code の session の一時 file がある。
  const claudeTmp = join(realpathSync('/tmp'), `claude-${process.getuid!()}`)

  async function judgePath(raw: unknown, access: 'read' | 'write'): Promise<Verdict> {
    const refused = deny(
      access === 'read'
        ? `Reading ${String(raw)} is refused; you can read only inside the Study, Tutor and Learning Preference dirs.`
        : `Writing ${String(raw)} is refused; you can write only inside the Study and Learning Preference dirs.`,
    )
    if (typeof raw !== 'string' || raw === '') return refused
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
    if (expanded.split('/').includes('..')) return refused
    const real = await nearestRealPath(isAbsolute(expanded) ? expanded : join(studyDir, expanded))
    return real && (access === 'read' ? readable : writable).some((dir) => inside(real, dir))
      ? ALLOW
      : refused
  }

  async function judgeUrl(raw: unknown): Promise<Verdict> {
    const refused = deny(
      `Fetching ${String(raw)} is refused; you can fetch only public http or https URLs.`,
    )
    let url: URL
    try {
      url = new URL(String(raw))
    } catch {
      return refused
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return refused
    return (await isLocalHost(url.hostname, deps.lookup)) ? refused : ALLOW
  }

  // hook と canUseTool のどちらの経路で来ても同じ線になるよう、判定をここ 1 つにする。
  async function judgeTool(tool: string, input: Record<string, unknown>): Promise<Verdict | null> {
    switch (tool) {
      case 'Read':
        return judgePath(input.file_path, 'read')
      case 'Write':
      case 'Edit':
        return judgePath(input.file_path, 'write')
      case 'Glob':
        if (typeof input.pattern === 'string' && climbsOut(input.pattern)) {
          return deny(
            'A Glob with an absolute pattern, or with glob syntax other than * next to a dot, is refused; give a relative pattern such as src/**/*.md and a path inside the box.',
          )
        }
        return judgePath(input.path ?? studyDir, 'read')
      case 'Grep':
        return judgePath(input.path ?? studyDir, 'read')
      case 'WebFetch':
        return judgeUrl(input.url)
      default:
        return null
    }
  }

  const canUseTool: CanUseTool = async (tool, input, { signal }) => {
    if (tool === 'SandboxNetworkAccess') {
      const host = String(input.host)
      return (await isLocalHost(host, deps.lookup))
        ? toResult(deny(`Connecting to ${host} is refused; you can reach only public hosts.`))
        : toResult(ALLOW)
    }
    if (tool === 'Bash') {
      if (input.dangerouslyDisableSandbox !== true) return toResult(ALLOW)
      const request = {
        command: String(input.command),
        description: typeof input.description === 'string' ? input.description : null,
      }
      return toResult(await askUser(request, signal))
    }
    return toResult(
      (await judgeTool(tool, input)) ?? deny(`The ${tool} tool is not available in this Study.`),
    )
  }

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const verdict =
      deps.reflecting?.() && !REFLECTION_TOOLS.includes(input.tool_name)
        ? deny(
            `The ${input.tool_name} tool is not available while reflecting; use only Read, Write and Edit.`,
          )
        : await judgeTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
    if (!verdict) return {}
    return {
      hookSpecificOutput: verdict.allow
        ? { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
        : {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: verdict.message,
          },
    }
  }

  return {
    cwd: studyDir,
    additionalDirectories: [tutorDir, learningPreferenceDir],
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'],
    // Bash・file の tool・WebFetch に allow rule を置くと、dangerouslyDisableSandbox の試し直しも聞かずに通る。
    allowedTools: ['WebSearch'],
    strictMcpConfig: true,
    permissionMode: 'default',
    permissionPrompts: 'host',
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      // false だと dangerouslyDisableSandbox の Bash が canUseTool に届かず、黙って箱の中で走る。
      allowUnsandboxedCommands: true,
      network: {
        // Seatbelt は symlink を解いた後の path で照らす。
        allowUnixSockets: nixSocket ? [nixSocket] : [],
        // mise の HTTP client が system の proxy 設定と証明書の検証に使う。
        allowMachLookup: ['com.apple.SystemConfiguration.configd', 'com.apple.trustd.agent'],
      },
      filesystem: {
        // monica の home は HOME の外にもありうるので、別に断る。
        denyRead: [home, deps.monicaHome, claudeTmp],
        allowRead: readable,
        allowWrite: [learningPreferenceDir],
        denyWrite: [tutorDir, claudeTmp],
      },
    },
    settings: {
      crossSessionInbound: 'refuse',
      permissions: { deny: [`Edit(/${tutorDir}/**)`] },
    },
    env: { CLAUDE_CODE_RESTRICTED: '1', CLAUDE_CODE_TMPDIR: TUTOR_TMPDIR },
  }
}
