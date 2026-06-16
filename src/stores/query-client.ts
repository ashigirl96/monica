// @tanstack/react-query は意図的に入れない: component-local hook が要る Phase まで core だけで足りる。
import { QueryClient } from "@tanstack/query-core";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
