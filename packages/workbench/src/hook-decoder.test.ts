import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeHook } from "./hook-decoder.ts";
import type { HookSignal } from "./transition.ts";

const fixtures = join(import.meta.dir, "../../../docs/research/hook-payloads");

type Captured = {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  transcript_path: string;
  permission_mode?: string;
  [field: string]: unknown;
};

function fixture(name: string): Captured {
  return require(join(fixtures, name));
}

const expected: Record<string, HookSignal> = {
  "session-start-startup.json": { type: "sessionStarted", compacted: false },
  "session-start-resume.json": { type: "sessionStarted", compacted: false },
  "session-start-clear.json": { type: "sessionStarted", compacted: false },
  "session-start-compact.json": { type: "sessionStarted", compacted: true },
  "user-prompt-submit.json": { type: "promptSubmitted" },
  "user-prompt-submit-task-notification-shell.json": { type: "promptSubmitted" },
  "user-prompt-submit-task-notification-subagent.json": { type: "promptSubmitted" },
  "pre-tool-use-ask-user-question.json": { type: "questionAsked" },
  "permission-request-ask-user-question.json": { type: "questionAsked" },
  "permission-request-ask-user-question-auto-mode.json": { type: "questionAsked" },
  "permission-request-exit-plan-mode.json": { type: "planSubmitted" },
  "permission-request-bash.json": { type: "permissionRequested", tool: "Bash" },
  "permission-request-bash-from-subagent.json": { type: "permissionRequested", tool: "Bash" },
  "post-tool-use-ask-user-question.json": { type: "questionAnswered" },
  "post-tool-use-bash.json": { type: "toolFinished" },
  "post-tool-use-bash-background.json": { type: "toolFinished" },
  "post-tool-use-agent-background.json": { type: "toolFinished" },
  "post-tool-use-bash-from-subagent.json": { type: "toolFinished" },
  "post-tool-use-failure-bash.json": { type: "toolFinished" },
  "stop.json": { type: "turnStopped", agentWorkRunning: false },
  "stop-background-shell.json": { type: "turnStopped", agentWorkRunning: false },
  "stop-background-subagent.json": { type: "turnStopped", agentWorkRunning: true },
  "stop-background-subagent-awaiting-permission.json": {
    type: "turnStopped",
    agentWorkRunning: true,
  },
  "stop-failure-400.json": { type: "turnFailed", error: "unknown" },
  "stop-failure-401.json": { type: "turnFailed", error: "authentication_failed" },
  "stop-failure-429.json": { type: "turnFailed", error: "rate_limit" },
  "stop-failure-500.json": { type: "turnFailed", error: "server_error" },
  "stop-failure-529.json": { type: "turnFailed", error: "server_error" },
  "session-end-prompt-input-exit.json": { type: "sessionEnded", reason: "prompt_input_exit" },
  "session-end-clear.json": { type: "sessionEnded", reason: "clear" },
  "session-end-other-sighup.json": { type: "sessionEnded", reason: "other" },
};

test("every captured payload has an expected event", () => {
  expect(readdirSync(fixtures).toSorted()).toEqual(Object.keys(expected).toSorted());
});

test.each(Object.entries(expected))("%s decodes to its event", (name, event) => {
  const payload = fixture(name);

  expect(decodeHook(payload, "ts-a")).toEqual({
    sessionId: payload.session_id,
    terminalSessionId: "ts-a",
    hookEventName: payload.hook_event_name,
    cwd: payload.cwd,
    transcriptPath: payload.transcript_path,
    permissionMode: payload.permission_mode ?? null,
    ...event,
  });
});

test.each([
  ["subagent", "running", true],
  ["workflow", "running", true],
  ["teammate", "running", true],
  ["subagent", "completed", false],
  ["monitor", "running", false],
  ["MCP task", "running", false],
  ["cloud session", "running", false],
  ["something new", "running", false],
])("a Stop with a %s task that is %s holds for agent work: %p", (type, status, held) => {
  const payload = { ...fixture("stop.json"), background_tasks: [{ id: "x", type, status }] };

  expect(decodeHook(payload, "ts-a")).toMatchObject({ agentWorkRunning: held });
});

test("a Stop without background_tasks has no agent work", () => {
  const { background_tasks: _, ...payload } = fixture("stop.json");

  expect(decodeHook(payload, "ts-a")).toMatchObject({
    type: "turnStopped",
    agentWorkRunning: false,
  });
});

test("a PreToolUse other than AskUserQuestion, a hook outside the nine, and a payload without session_id decode to nothing", () => {
  const preToolUse = { ...fixture("pre-tool-use-ask-user-question.json"), tool_name: "Bash" };
  const subagentStop = { ...fixture("stop.json"), hook_event_name: "SubagentStop" };
  const { session_id: _, ...anonymous } = fixture("user-prompt-submit.json");

  expect(decodeHook(preToolUse, "ts-a")).toBeNull();
  expect(decodeHook(subagentStop, "ts-a")).toBeNull();
  expect(decodeHook(anonymous, "ts-a")).toBeNull();
});
