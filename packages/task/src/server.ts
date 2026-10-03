import { EventPublisher, implement } from "@orpc/server";
import type { Db, Workbench } from "@tania/workbench/server";
import { contract } from "./contract.ts";

export { migrations } from "../migrations/index.ts";

export type Task = {
  events: EventPublisher<Record<never, never>>;
  start(): void;
  stop(): void;
};

export const router = implement(contract).$context<{ db: Db; task: Task }>().router({});

export function createTask(_deps: { db: Db; workbench: Workbench }): Task {
  return { events: new EventPublisher(), start() {}, stop() {} };
}

export function nameAgentSession(_db: Db, _agentSessionId: string): string | null {
  return null;
}
