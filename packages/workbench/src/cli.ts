import type { TerminalSession } from "./contract.ts";

export const commands = [] as const;

export const formatters = {
  terminalSession: {
    list(sessions: TerminalSession[]): string {
      if (sessions.length === 0) return "No live Terminal Sessions";
      return table([
        ["ID", "STATUS", "PID", "CWD"],
        ...sessions.map((s) => [s.id, s.status, s.pid === null ? "-" : String(s.pid), s.cwd]),
      ]);
    },
  },
};

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
