import { z } from "zod";
import type { HookEvent, HookSignal } from "./transition.ts";

// shell や monitor などを数えないのは、dev server を background に置いたまま turn を終えた agent を手空きに見せるため（ADR-0008）。
const AGENT_WORK = ["subagent", "workflow", "teammate"];

const Payload = z.object({
  session_id: z.string(),
  cwd: z.string(),
  hook_event_name: z.string(),
  transcript_path: z.string().nullish(),
  permission_mode: z.string().nullish(),
  tool_name: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
  background_tasks: z
    .array(z.object({ type: z.string().optional(), status: z.string().optional() }))
    .optional(),
});

type Payload = z.infer<typeof Payload>;

export function decodeHook(payload: unknown, terminalSessionId: string): HookEvent | null {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) return null;
  const signal = signalOf(parsed.data);
  if (!signal) return null;
  return {
    sessionId: parsed.data.session_id,
    terminalSessionId,
    hookEventName: parsed.data.hook_event_name,
    cwd: parsed.data.cwd,
    transcriptPath: parsed.data.transcript_path ?? null,
    permissionMode: parsed.data.permission_mode ?? null,
    ...signal,
  };
}

function signalOf(payload: Payload): HookSignal | null {
  const tool = payload.tool_name;
  switch (payload.hook_event_name) {
    case "SessionStart":
      return { type: "sessionStarted", compacted: payload.source === "compact" };
    case "UserPromptSubmit":
      return { type: "promptSubmitted" };
    case "PreToolUse":
      return tool === "AskUserQuestion" ? { type: "questionAsked" } : null;
    // AskUserQuestion は PreToolUse の直後に PermissionRequest も来るので、同じ質問として扱う。
    case "PermissionRequest":
      if (tool === "AskUserQuestion") return { type: "questionAsked" };
      if (tool === "ExitPlanMode") return { type: "planSubmitted" };
      return tool ? { type: "permissionRequested", tool } : null;
    case "PostToolUse":
    case "PostToolUseFailure":
      return tool === "AskUserQuestion" ? { type: "questionAnswered" } : { type: "toolFinished" };
    case "Stop":
      return {
        type: "turnStopped",
        agentWorkRunning: (payload.background_tasks ?? []).some(
          (task) => task.status === "running" && AGENT_WORK.includes(task.type ?? ""),
        ),
      };
    case "StopFailure":
      return { type: "turnFailed", error: payload.error ?? null };
    case "SessionEnd":
      return { type: "sessionEnded", reason: payload.reason ?? null };
    default:
      return null;
  }
}
