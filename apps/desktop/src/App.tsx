import { Toaster } from "@tania/ui";
import { Workbench } from "@tania/workbench/ui";
import { useMemo } from "react";
import { useBackend } from "./backend-provider.tsx";
import { useShortcuts } from "./use-shortcuts.ts";

export function App() {
  useShortcuts();
  const client = useBackend();
  // oRPC の client は property を読むたびに新しい Proxy を返すので、endpoint ごとに 1 つに固定する。
  const workbench = useMemo(() => client?.workbench ?? null, [client]);

  return (
    <>
      <Workbench client={workbench} />
      <Toaster />
    </>
  );
}
