import type { TerminalSession } from "@tania/workbench/contract";
import { useEffect, useState } from "react";
import { useBackend } from "./backend-provider.tsx";

// 仮の画面。骨格 (4b) が Workbench の画面に置き換える。
export function App() {
  const client = useBackend();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    const reload = async () => setSessions(await client.workbench.terminalSession.list());
    void (async () => {
      try {
        // 先に購読してから読むので、読んだ後の変更を取りこぼさない。
        const changes = await client.workbench.changes(undefined, { signal: controller.signal });
        await reload();
        for await (const _ of changes) await reload();
      } catch (error) {
        if (!controller.signal.aborted) console.error("workbench.changes ended", error);
      }
    })();
    return () => controller.abort();
  }, [client]);

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: 16 }}>
      <h1 style={{ fontSize: 16 }}>Terminal Sessions</h1>
      <table cellPadding={6} style={{ borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left">id</th>
            <th align="left">status</th>
            <th align="left">pid</th>
            <th align="left">cwd</th>
            <th align="left">created</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>{session.id}</td>
              <td>{session.status}</td>
              <td>{session.pid ?? ""}</td>
              <td>{session.cwd}</td>
              <td>{session.createdAt.toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
