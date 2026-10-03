import type { ContractRouterClient } from "@orpc/contract";
import { type PopoverAnchor, pushErrorToast } from "@tania/ui";
import { atom, type Getter, type Setter } from "jotai";
import type { contract, Layout, Tab } from "../contract.ts";
import { jumpHintsActiveAtom } from "./jump-hints.ts";
import { shortPath } from "./paths.ts";
import {
  applyTerminalSessionListAtom,
  isDeadStatus,
  markEndedAtom,
  setTerminalSessionStatusAtom,
  type TerminalSessionStatusEntry,
  terminalSessionStatusAtom,
} from "./terminal-sessions.ts";
import { terminalDetach } from "./terminal.ts";
import { getTabTerminal, releaseTabConnection } from "./terminal-connections.ts";

export type WorkbenchClient = ContractRouterClient<typeof contract>;
export type Runspace = Layout["runspaces"][number];

// oRPC の client は callable な Proxy で、jotai の set が updater と取り違えるので `() => client` で渡す。
export const workbenchClientAtom = atom<WorkbenchClient | null>(null);

export const layoutAtom = atom<Layout | null>(null);

export const terminalFocusRequestAtom = atom(0);

function clientOf(get: Getter): WorkbenchClient {
  const client = get(workbenchClientAtom);
  if (!client) throw new Error("Backend is unavailable");
  return client;
}

export function warnFailed(what: string, e: unknown): void {
  console.warn(`${what} failed:`, e);
}

// Backend が居ないと layout を変える操作は失敗するが、画面は塞がず toast で 1 行知らせる。
function action<Args extends unknown[]>(
  run: (get: Getter, set: Setter, ...args: Args) => Promise<void>,
) {
  return atom(null, async (get, set, ...args: Args) => {
    try {
      await run(get, set, ...args);
    } catch (e) {
      pushErrorToast(e instanceof Error ? e.message : String(e));
    }
  });
}

const DEFAULT_SIZE = { rows: 24, cols: 80 };

// 新しい Tab の pane はまだ無いので、同じ領域に出ている Tab の大きさで作り、attach の resize で追いつかせる。
function sizeOf(tab: Tab | null) {
  const term = tab && getTabTerminal(tab.id);
  return term ? { rows: term.rows, cols: term.cols } : DEFAULT_SIZE;
}

async function load(get: Getter, set: Setter) {
  const client = clientOf(get);
  let layout = await client.layout.get();
  // 所有されていない Runspace が 1 つも無い画面は作らず、最後の Tab が閉じたら新しい Runspace で始める。
  if (layout.runspaces.length === 0) {
    await client.runspace.create(DEFAULT_SIZE);
    layout = await client.layout.get();
  }
  const sessions = await client.terminalSession.list();
  set(layoutAtom, layout);
  set(applyTerminalSessionListAtom, sessions);
}

// promise は jotai が値として追跡するので、object に包んで持つ。
const lastReloadAtom = atom<{ done: Promise<void> }>({ done: Promise.resolve() });
const waitingReloadAtom = atom<{ done: Promise<void> } | null>(null);

// 応答が前後して古い layout で上書きしないよう読み直しは 1 本ずつ流し、待つ間に来た要求は 1 回にまとめる。
export const reloadAtom = atom(null, (get, set): Promise<void> => {
  const waiting = get(waitingReloadAtom);
  if (waiting) return waiting.done;
  const reload = {
    done: get(lastReloadAtom).done.then(() => {
      set(waitingReloadAtom, null);
      return load(get, set);
    }),
  };
  set(waitingReloadAtom, reload);
  set(lastReloadAtom, { done: reload.done.catch(() => {}) });
  return reload.done;
});

// active な Runspace と Tab は帳簿に持たないので、id が layout から消えたら先頭を見せる。
const activeRunspaceIdAtom = atom<string | null>(null);
const activeTabIdsAtom = atom<Record<string, string>>({});

export const activeRunspaceAtom = atom((get): Runspace | null => {
  const runspaces = get(layoutAtom)?.runspaces ?? [];
  const id = get(activeRunspaceIdAtom);
  return runspaces.find((r) => r.id === id) ?? runspaces[0] ?? null;
});

function activeTabOf(get: Getter, runspace: Runspace): Tab | null {
  const id = get(activeTabIdsAtom)[runspace.id];
  return runspace.tabs.find((t) => t.id === id) ?? runspace.tabs[0] ?? null;
}

export const activeTerminalTabAtom = atom((get) => {
  const runspace = get(activeRunspaceAtom);
  return runspace ? activeTabOf(get, runspace) : null;
});

// 切り替えはすべてここを通るので、jump hint を閉じるのもここで行う。
const setActiveAtom = atom(null, (get, set, next: { runspaceId: string; tabId?: string }) => {
  const before = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id];
  set(activeRunspaceIdAtom, next.runspaceId);
  const { tabId } = next;
  if (tabId) set(activeTabIdsAtom, (prev) => ({ ...prev, [next.runspaceId]: tabId }));
  const after = [get(activeRunspaceAtom)?.id, get(activeTerminalTabAtom)?.id];
  if (before[0] !== after[0] || before[1] !== after[1]) set(jumpHintsActiveAtom, false);
});

export const activateRunspaceAtom = atom(null, (_get, set, runspaceId: string) => {
  set(setActiveAtom, { runspaceId });
  set(terminalFocusRequestAtom, (c) => c + 1);
});

export const activateTerminalTabAtom = atom(null, (get, set, tabId: string) => {
  const runspace = get(activeRunspaceAtom);
  if (!runspace?.tabs.some((t) => t.id === tabId)) return;
  set(setActiveAtom, { runspaceId: runspace.id, tabId });
  set(terminalFocusRequestAtom, (c) => c + 1);
});

// OSC 0/2 の title は shell が prompt のたびに書き換えるので、帳簿に書かず memory にだけ持つ。
export const tabTitlesAtom = atom<Record<string, string>>({});

// OSC 7 を出す shell の title は同じ cwd の `~` 付きの別表記なので、そういう Tab の cwd は OSC 7 だけから取る。
const tabsReportingCwdAtom = atom<ReadonlySet<string>>(new Set<string>());

// OSC 7 を出さない shell でも、title を path にする設定なら cwd を追える。
export const updateTabTitleAtom = atom(null, (get, set, tabId: string, title: string) => {
  set(tabTitlesAtom, (prev) => ({ ...prev, [tabId]: title }));
  // `~user` や zsh の named directory は Backend が絶対 path にできないので、`~` と `~/` の形だけを取る。
  const isPath = title.startsWith("/") || title === "~" || title.startsWith("~/");
  if (!isPath || get(tabsReportingCwdAtom).has(tabId)) return Promise.resolve();
  return writeCwd(get, set, tabId, title);
});

export const updateTabCwdAtom = atom(null, (get, set, tabId: string, cwd: string) => {
  if (!get(tabsReportingCwdAtom).has(tabId)) {
    set(tabsReportingCwdAtom, (prev) => new Set(prev).add(tabId));
  }
  return writeCwd(get, set, tabId, cwd);
});

// cwd は prompt のたびに届くので、Tab ごとに最後に送った値と比べ、変わったときだけ書く。
const sentCwdsAtom = atom<Record<string, string>>({});
// 応答が前後して古い cwd が最後に残らないよう、書き込みは 1 本の列で流す。
const cwdWritesAtom = atom<{ done: Promise<void> }>({ done: Promise.resolve() });

function writeCwd(get: Getter, set: Setter, tabId: string, cwd: string): Promise<void> {
  if (cwd === (get(sentCwdsAtom)[tabId] ?? findTab(get, tabId)?.tab.cwd)) return Promise.resolve();
  set(sentCwdsAtom, (prev) => ({ ...prev, [tabId]: cwd }));
  const forget = () =>
    set(sentCwdsAtom, (prev) => {
      if (prev[tabId] !== cwd) return prev;
      const { [tabId]: _, ...rest } = prev;
      return rest;
    });
  const done = get(cwdWritesAtom)
    .done.then(() => clientOf(get).tab.setCwd({ id: tabId, cwd }))
    .catch((e: unknown) => {
      // 届かなかった cwd は、次に同じ値が来たときに送り直す。
      forget();
      if (!isGone(e)) warnFailed("cwd update", e);
    });
  set(cwdWritesAtom, { done });
  return done;
}

function holdsPin(runspace: Runspace): boolean {
  return runspace.tabs.some((t) => t.pinned);
}

const sidebarRunspacesAtom = atom((get): Runspace[] => {
  const runspaces = get(layoutAtom)?.runspaces ?? [];
  return [...runspaces.filter(holdsPin), ...runspaces.filter((r) => !holdsPin(r))];
});

export type RunspaceSummary = {
  id: string;
  title: string;
  description: string;
  tabCount: number;
  isActive: boolean;
  holdsPin: boolean;
};

export const runspaceSummariesAtom = atom((get): RunspaceSummary[] => {
  const active = get(activeRunspaceAtom);
  const titles = get(tabTitlesAtom);
  return get(sidebarRunspacesAtom).map((runspace) => {
    const tab = activeTabOf(get, runspace);
    return {
      id: runspace.id,
      title: shortPath(tab?.cwd ?? runspace.cwd),
      description: (tab && titles[tab.id]) ?? "",
      tabCount: runspace.tabs.length,
      isActive: runspace.id === active?.id,
      holdsPin: holdsPin(runspace),
    };
  });
});

export const createRunspaceAtom = action(async (get, set) => {
  const active = get(activeRunspaceAtom);
  const tab = get(activeTerminalTabAtom);
  const { runspaceId } = await clientOf(get).runspace.create({
    cwd: tab?.cwd,
    index: active ? active.sortOrder + 1 : undefined,
    ...sizeOf(tab),
  });
  await set(reloadAtom);
  set(activateRunspaceAtom, runspaceId);
});

export const createTerminalTabAtom = action(async (get, set) => {
  const runspace = get(activeRunspaceAtom);
  if (!runspace) return;
  const tab = activeTabOf(get, runspace);
  const opened = await clientOf(get).tab.open({
    runspaceId: runspace.id,
    cwd: tab?.cwd,
    index: tab ? tab.sortOrder + 1 : undefined,
    ...sizeOf(tab),
  });
  await set(reloadAtom);
  set(activateTerminalTabAtom, opened.id);
});

type TabInRunspace = { runspace: Runspace; tab: Tab };

function findTab(get: Getter, tabId: string): TabInRunspace | null {
  for (const runspace of get(layoutAtom)?.runspaces ?? []) {
    const tab = runspace.tabs.find((t) => t.id === tabId);
    if (tab) return { runspace, tab };
  }
  return null;
}

function frontTab(get: Getter): TabInRunspace | null {
  const runspace = get(activeRunspaceAtom);
  const tab = runspace && activeTabOf(get, runspace);
  return runspace && tab ? { runspace, tab } : null;
}

// 別の経路（Exit と手の close、CLI）で先に消えた Tab は、閉じたのと同じに扱う。
function isGone(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "NOT_FOUND";
}

function detachTab(tab: Tab) {
  const terminalSessionId = releaseTabConnection(tab.id) ?? tab.terminalSessionId;
  terminalDetach(terminalSessionId).catch((e: unknown) => warnFailed("terminal detach", e));
}

async function closeTab(
  get: Getter,
  set: Setter,
  { runspace, tab }: TabInRunspace,
  afterClose?: () => void,
) {
  try {
    await clientOf(get).tab.close({ id: tab.id });
  } catch (e) {
    if (!isGone(e)) throw e;
  }
  afterClose?.();
  if (activeTabOf(get, runspace)?.id === tab.id) {
    const rest = runspace.tabs.filter((t) => t.id !== tab.id);
    const next = rest[Math.min(runspace.tabs.indexOf(tab), rest.length - 1)];
    if (next) set(activeTabIdsAtom, (prev) => ({ ...prev, [runspace.id]: next.id }));
  }
  await set(reloadAtom);
}

export const closeTerminalTabAtom = action(async (get, set, tabId?: string) => {
  const found = tabId ? findTab(get, tabId) : frontTab(get);
  if (found) await closeTab(get, set, found, () => detachTab(found.tab));
});

// 接続中の Tab は Exit で閉じるので、閉じ終わるまでの間も終わった印を出さない。
const closingTabIdsAtom = atom<ReadonlySet<string>>(new Set<string>());

export const deadTabsAtom = atom((get) => {
  const statuses = get(terminalSessionStatusAtom);
  const closing = get(closingTabIdsAtom);
  const dead: Record<string, TerminalSessionStatusEntry> = {};
  for (const tab of get(layoutAtom)?.runspaces.flatMap((r) => r.tabs) ?? []) {
    const entry = statuses[tab.terminalSessionId];
    if (entry && isDeadStatus(entry.status) && !closing.has(tab.id)) dead[tab.id] = entry;
  }
  return dead;
});

// Exit の後は止める出力が無いので、detach を送らずに閉じる。
export const tabExitedAtom = action(
  async (get, set, tabId: string, terminalSessionId: string, exitCode: number | null) => {
    const found = findTab(get, tabId);
    // Backend の張り直しが先に届いた Tab は、もう新しい shell を指している。
    if (found?.tab.terminalSessionId !== terminalSessionId) return;
    releaseTabConnection(tabId);
    set(markEndedAtom, terminalSessionId);
    set(setTerminalSessionStatusAtom, terminalSessionId, { status: "exited", exitCode });
    // pin された Tab は Backend が張り直す。
    if (found.tab.pinned) return;
    set(closingTabIdsAtom, (prev) => new Set(prev).add(tabId));
    try {
      await closeTab(get, set, found);
    } finally {
      set(closingTabIdsAtom, (prev) => new Set([...prev].filter((id) => id !== tabId)));
    }
  },
);

// 切り出しと付け替えは Backend が決めるので、書いた後の layout から Tab の居場所を読み直す。
export const toggleTabPinAtom = action(async (get, set, tabId?: string) => {
  const found = tabId ? findTab(get, tabId) : frontTab(get);
  if (!found) return;
  const { id, pinned } = found.tab;
  const inFront = get(activeTerminalTabAtom)?.id === id;
  const client = clientOf(get);
  await (pinned ? client.tab.unpin({ id }) : client.tab.pin({ id }));
  await set(reloadAtom);
  const moved = findTab(get, id);
  if (inFront && moved) set(setActiveAtom, { runspaceId: moved.runspace.id, tabId: id });
});

export const startNewShellForTabAtom = action(async (get, set, tabId: string) => {
  const found = findTab(get, tabId);
  if (!found) return;
  releaseTabConnection(tabId);
  await clientOf(get).tab.respawn({ id: tabId, ...sizeOf(found.tab) });
  await set(reloadAtom);
});

export const reattachTerminalSessionAtom = action(async (get, set, terminalSessionId: string) => {
  const runspace = get(activeRunspaceAtom);
  if (!runspace) return;
  const tab = await clientOf(get).tab.open({
    runspaceId: runspace.id,
    terminalSessionId,
    ...sizeOf(activeTabOf(get, runspace)),
  });
  await set(reloadAtom);
  set(activateTerminalTabAtom, tab.id);
});

export const terminateTerminalSessionAtom = action(async (get, set, terminalSessionId: string) => {
  await clientOf(get).terminalSession.terminate({ id: terminalSessionId });
  set(markEndedAtom, terminalSessionId);
  await set(reloadAtom);
});

export type TabMenuState = {
  tabId: string;
  anchor: PopoverAnchor;
  confirmingTerminate: boolean;
};

export const tabMenuAtom = atom<TabMenuState | null>(null);

export const tabMenuTabAtom = atom((get) => {
  const menu = get(tabMenuAtom);
  return menu ? (findTab(get, menu.tabId)?.tab ?? null) : null;
});

export const terminateTabTerminalSessionAtom = action(async (get, set, tabId: string) => {
  const found = findTab(get, tabId);
  if (!found) return;
  await clientOf(get).terminalSession.terminate({ id: found.tab.terminalSessionId });
  releaseTabConnection(tabId);
  set(markEndedAtom, found.tab.terminalSessionId);
  await closeTab(get, set, found);
});

function cycle<T>(items: T[], current: T | null | undefined, step: 1 | -1): T | undefined {
  const index = current === null || current === undefined ? -1 : items.indexOf(current);
  return items[(index + step + items.length) % items.length];
}

export const cycleRunspaceAtom = atom(null, (get, set, direction: "up" | "down") => {
  const runspaces = get(sidebarRunspacesAtom);
  if (runspaces.length <= 1) return;
  const next = cycle(runspaces, get(activeRunspaceAtom), direction === "up" ? -1 : 1);
  if (next) set(setActiveAtom, { runspaceId: next.id });
});

export const cycleTerminalTabAtom = atom(null, (get, set, direction: "left" | "right") => {
  const runspace = get(activeRunspaceAtom);
  if (!runspace || runspace.tabs.length <= 1) return;
  const next = cycle(runspace.tabs, activeTabOf(get, runspace), direction === "left" ? -1 : 1);
  if (next) set(setActiveAtom, { runspaceId: runspace.id, tabId: next.id });
});

// sidebar のグループは帳簿の並びより先に効くので、グループをまたいで動かしても見た目の位置にならない。
async function moveRunspaceTo(get: Getter, set: Setter, id: string, toId: string) {
  const runspaces = get(layoutAtom)?.runspaces ?? [];
  const from = runspaces.find((r) => r.id === id);
  const index = runspaces.findIndex((r) => r.id === toId);
  const to = runspaces[index];
  if (!from || !to || holdsPin(from) !== holdsPin(to)) return;
  await clientOf(get).runspace.move({ id, index });
  await set(reloadAtom);
}

async function moveTab(get: Getter, set: Setter, id: string, runspaceId: string, index: number) {
  await clientOf(get).tab.move({ id, runspaceId, index });
  await set(reloadAtom);
}

export const reorderRunspacesAtom = action(moveRunspaceTo);

export const reorderTabsAtom = action(async (get, set, fromId: string, toId: string) => {
  const runspace = get(activeRunspaceAtom);
  const index = runspace?.tabs.findIndex((t) => t.id === toId) ?? -1;
  if (runspace && index >= 0) await moveTab(get, set, fromId, runspace.id, index);
});

export const moveActiveRunspaceAtom = action(async (get, set, direction: "up" | "down") => {
  const runspaces = get(sidebarRunspacesAtom);
  const active = get(activeRunspaceAtom);
  const neighbor = active && runspaces[runspaces.indexOf(active) + (direction === "up" ? -1 : 1)];
  if (active && neighbor) await moveRunspaceTo(get, set, active.id, neighbor.id);
});

export const moveActiveTabAtom = action(async (get, set, direction: "left" | "right") => {
  const runspace = get(activeRunspaceAtom);
  const tab = runspace && activeTabOf(get, runspace);
  if (!runspace || !tab) return;
  const index = runspace.tabs.indexOf(tab) + (direction === "left" ? -1 : 1);
  if (index >= 0 && index < runspace.tabs.length) {
    await moveTab(get, set, tab.id, runspace.id, index);
  }
});

export const draggedTabIdAtom = atom<string | null>(null);

export const moveTabToRunspaceAtom = action(async (get, set, tabId: string, runspaceId: string) => {
  const found = findTab(get, tabId);
  const target = get(layoutAtom)?.runspaces.find((r) => r.id === runspaceId);
  if (!found || !target || found.runspace.id === runspaceId) return;
  const inFront = get(activeTerminalTabAtom)?.id === tabId;
  await moveTab(get, set, tabId, runspaceId, target.tabs.length);
  if (inFront) set(setActiveAtom, { runspaceId, tabId });
});
