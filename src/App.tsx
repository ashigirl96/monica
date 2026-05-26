import { Suspense } from "react";
import { MilkdownPlayground } from "@/features/playground";

function PlaygroundFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      Loading playground…
    </div>
  );
}

function App() {
  return (
    <Suspense fallback={<PlaygroundFallback />}>
      <MilkdownPlayground />
    </Suspense>
  );
}

export default App;
