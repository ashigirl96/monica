import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { contract as taskContract } from "@tania/task/contract";
import type { contract as workbenchContract } from "@tania/workbench/contract";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Endpoint = { port: number; token: string };
export type Client = ContractRouterClient<{
  workbench: typeof workbenchContract;
  task: typeof taskContract;
}>;

export function createClient(endpoint: Endpoint): Client {
  const link = new RPCLink({
    url: `http://127.0.0.1:${endpoint.port}/rpc`,
    headers: { authorization: `Bearer ${endpoint.token}` },
  });
  return createORPCClient(link);
}

export function restartBackend(): Promise<void> {
  return invoke("backend_restart");
}

export function watchBackend(handlers: {
  onEndpoint: (endpoint: Endpoint | null) => void;
  onFailed: () => void;
}): () => void {
  let active = true;
  let heard = false;
  const unlisten = [
    listen<Endpoint | null>("backend-endpoint", (event) => {
      heard = true;
      if (active) handlers.onEndpoint(event.payload);
    }),
    listen("backend-failed", () => {
      heard = true;
      if (active) handlers.onFailed();
    }),
  ];
  // listen を張ってから今の様子を訊く。張る前に出た event を取りこぼさず、答えより新しい event を答えで上書きしない。
  void Promise.all(unlisten)
    .then(() => invoke<{ endpoint: Endpoint | null; failed: boolean }>("backend_endpoint"))
    .then(({ endpoint, failed }) => {
      if (!active || heard) return;
      handlers.onEndpoint(endpoint);
      if (failed) handlers.onFailed();
    });
  return () => {
    active = false;
    for (const pending of unlisten) void pending.then((stop) => stop());
  };
}
