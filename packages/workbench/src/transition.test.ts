import { describe, expect, test } from "bun:test";
import type { AgentSession } from "./contract.ts";
import {
  type AgentEvent,
  type HookEvent,
  type HookSignal,
  supersede,
  transition,
} from "./transition.ts";

const BEFORE = new Date(1_000);
const NOW = new Date(2_000);

const blank = {
  waitReason: null,
  waitTool: null,
  errorType: null,
  endReason: null,
  sessionEndReason: null,
  endedAt: null,
  unobservedSince: null,
} satisfies Partial<AgentSession>;

type StateFields = Partial<AgentSession>;

const running: StateFields = { state: "running" };
const idle: StateFields = { state: "waiting", waitReason: "idle" };
const question: StateFields = { state: "waiting", waitReason: "question" };

const prior = {
  running,
  unobserved: { state: "unobserved", unobservedSince: BEFORE },
  idle,
  question,
  permission: { state: "waiting", waitReason: "permission", waitTool: "Edit" },
  error: { state: "waiting", waitReason: "error", errorType: "rate_limit" },
  ended: {
    state: "ended",
    endReason: "session_end",
    sessionEndReason: "prompt_input_exit",
    endedAt: BEFORE,
  },
} satisfies Record<string, StateFields>;

function rowIn(state: keyof typeof prior, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: "s-1",
    terminalSessionId: "ts-a",
    ...blank,
    ...prior[state],
    cwd: "/work",
    transcriptPath: "/transcripts/s-1.jsonl",
    permissionMode: "default",
    lastEventName: "Earlier",
    lastEventAt: BEFORE,
    stateChangedAt: BEFORE,
    firstSeenAt: BEFORE,
    ...overrides,
  } as AgentSession;
}

function hook(
  hookEventName: string,
  signal: HookSignal,
  overrides: Partial<HookEvent> = {},
): HookEvent {
  return {
    sessionId: "s-1",
    terminalSessionId: "ts-a",
    hookEventName,
    cwd: "/work",
    transcriptPath: "/transcripts/s-1.jsonl",
    permissionMode: "default",
    ...signal,
    ...overrides,
  } as HookEvent;
}

// to: 新しい状態か理由に入り、state_changed_at が今になる。stay: state_changed_at は動かず、fields だけを上書きする。
type Cell = { moved: boolean; fields: StateFields } | null;
const to = (fields: StateFields): Cell => ({ moved: true, fields });
const stay = (fields: StateFields = {}): Cell => ({ moved: false, fields });
const ignored: Cell = null;

const idleInB: StateFields = { ...idle, terminalSessionId: "ts-b" };
const permissionForBash: StateFields = {
  state: "waiting",
  waitReason: "permission",
  waitTool: "Bash",
};
const serverError: StateFields = {
  state: "waiting",
  waitReason: "error",
  errorType: "server_error",
};
const endedBySessionEnd: StateFields = {
  state: "ended",
  endReason: "session_end",
  sessionEndReason: "other",
  endedAt: NOW,
};
const endedWithTerminal: StateFields = {
  state: "ended",
  endReason: "terminal_exited",
  endedAt: NOW,
};
const unobserved: StateFields = { state: "unobserved", unobservedSince: NOW };

const columns = [...(Object.keys(prior) as (keyof typeof prior)[]), "unknown"] as const;

// 列は今の行の状態。unknown は session_id が帳簿に無い（行を動作中で作ってから当てる）。
// prettier-ignore
const table: [string, AgentEvent, Cell[]][] = [
  //                                                                                 running               unobserved            idle                  question              permission            error                 ended                 unknown
  ["SessionStart(resume) from another Terminal Session", hook("SessionStart", { type: "sessionStarted", compacted: false }, { terminalSessionId: "ts-b" }),
                                                                                    [to(idleInB),          to(idleInB),          stay(idleInB),        to(idleInB),          to(idleInB),          to(idleInB),          to(idleInB),          to(idleInB)]],
  ["SessionStart(compact)", hook("SessionStart", { type: "sessionStarted", compacted: true }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["UserPromptSubmit", hook("UserPromptSubmit", { type: "promptSubmitted" }),
                                                                                    [stay(),               to(running),          to(running),          to(running),          to(running),          to(running),          to(running),          stay()]],
  ["PreToolUse(AskUserQuestion) or PermissionRequest(AskUserQuestion)", hook("PreToolUse", { type: "questionAsked" }),
                                                                                    [to(question),         to(question),         to(question),         stay(),               to(question),         to(question),         to(question),         to(question)]],
  ["PermissionRequest(ExitPlanMode)", hook("PermissionRequest", { type: "planSubmitted" }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["PermissionRequest(Bash)", hook("PermissionRequest", { type: "permissionRequested", tool: "Bash" }),
                                                                                    [to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash), to(permissionForBash)]],
  ["PostToolUse(AskUserQuestion)", hook("PostToolUse", { type: "questionAnswered" }),
                                                                                    [stay(),               to(running),          stay(),               to(running),          to(running),          stay(),               ignored,              stay()]],
  ["PostToolUse(Bash) or PostToolUseFailure(Bash)", hook("PostToolUse", { type: "toolFinished" }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               to(running),          stay(),               ignored,              stay()]],
  ["Stop without agent work", hook("Stop", { type: "turnStopped", agentWorkRunning: false }),
                                                                                    [to(idle),             to(idle),             stay(),               stay(),               to(idle),             to(idle),             ignored,              to(idle)]],
  ["Stop with agent work running", hook("Stop", { type: "turnStopped", agentWorkRunning: true }),
                                                                                    [stay(),               to(running),          stay(),               stay(),               stay(),               stay(),               ignored,              stay()]],
  ["StopFailure(server_error)", hook("StopFailure", { type: "turnFailed", error: "server_error" }),
                                                                                    [to(serverError),      to(serverError),      to(serverError),      to(serverError),      to(serverError),      stay(serverError),    ignored,              to(serverError)]],
  ["SessionEnd(other)", hook("SessionEnd", { type: "sessionEnded", reason: "other" }),
                                                                                    [to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), to(endedBySessionEnd), ignored, to(endedBySessionEnd)]],
  ["the Terminal Session ended", { type: "terminalEnded" },
                                                                                    [to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), to(endedWithTerminal), ignored, ignored]],
  ["the Backend restarted while the Terminal Session lived", { type: "backendRestarted" },
                                                                                    [to(unobserved),       ignored,              ignored,              ignored,              ignored,              ignored,              ignored,              ignored]],
];

function firstSeen(event: HookEvent): AgentSession {
  return {
    sessionId: event.sessionId,
    terminalSessionId: event.terminalSessionId,
    ...blank,
    state: "running",
    cwd: event.cwd,
    transcriptPath: event.transcriptPath,
    permissionMode: event.permissionMode,
    lastEventName: event.hookEventName,
    lastEventAt: NOW,
    stateChangedAt: NOW,
    firstSeenAt: NOW,
  };
}

function expectedRow(prev: AgentSession | null, event: AgentEvent, cell: Cell) {
  if (!cell) return null;
  const observed = "sessionId" in event ? event : null;
  return {
    ...(prev ?? firstSeen(observed!)),
    ...(observed && { lastEventName: observed.hookEventName, lastEventAt: NOW }),
    ...(cell.moved && { ...blank, stateChangedAt: NOW }),
    ...cell.fields,
  };
}

describe.each(table)("%s", (_name, event, cells) => {
  test.each(columns.map((column, i) => [column, cells[i]!] as const))("from %s", (column, cell) => {
    const prev = column === "unknown" ? null : rowIn(column);

    expect(transition(prev, event, NOW)).toEqual(expectedRow(prev, event, cell));
  });
});

describe("another live Agent Session on the same Terminal Session", () => {
  const superseded: StateFields = { state: "ended", endReason: "superseded", endedAt: NOW };
  const startup = hook(
    "SessionStart",
    { type: "sessionStarted", compacted: false },
    { sessionId: "s-2" },
  );

  test.each(["running", "unobserved", "idle", "question", "permission", "error"] as const)(
    "ends as superseded from %s when a new session starts there",
    (state) => {
      const prev = rowIn(state);

      expect(supersede(prev, startup, NOW)).toEqual({
        ...prev,
        ...blank,
        ...superseded,
        stateChangedAt: NOW,
      });
    },
  );

  test("stays ended when it had already ended", () => {
    expect(supersede(rowIn("ended"), startup, NOW)).toBeNull();
  });

  test("is left alone by events of the other session that are not a start", () => {
    const prompt = hook("UserPromptSubmit", { type: "promptSubmitted" }, { sessionId: "s-2" });

    expect(supersede(rowIn("running"), prompt, NOW)).toBeNull();
  });

  test("is left alone by a session starting on another Terminal Session", () => {
    const elsewhere = { ...startup, terminalSessionId: "ts-b" };

    expect(supersede(rowIn("running"), elsewhere, NOW)).toBeNull();
  });
});

test("a hook carrying a permission mode records it, and one without keeps the last known mode", () => {
  const plan = hook("UserPromptSubmit", { type: "promptSubmitted" }, { permissionMode: "plan" });
  const unknown = hook(
    "SessionEnd",
    { type: "sessionEnded", reason: "other" },
    { permissionMode: null },
  );

  expect(transition(rowIn("idle"), plan, NOW)?.permissionMode).toBe("plan");
  expect(
    transition(rowIn("running", { permissionMode: "plan" }), unknown, NOW)?.permissionMode,
  ).toBe("plan");
});
