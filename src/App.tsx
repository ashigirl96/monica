import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";

function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("");

  async function greet() {
    setGreeting(await invoke<string>("greet", { name }));
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8 text-foreground">
      <h1 className="text-3xl font-bold tracking-tight">monica</h1>
      <p className="text-sm text-muted-foreground">Tauri 2 · Bun · Vite · React 19</p>

      <form
        className="flex w-full max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void greet();
        }}
      >
        <input
          className={cn(
            "h-10 rounded-md border border-input bg-transparent px-3 text-sm",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
          placeholder="Enter a name..."
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <button
          type="submit"
          className={cn(
            "h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground",
            "transition-colors hover:bg-primary/90",
          )}
        >
          Greet
        </button>
      </form>

      {greeting && <p className="text-base">{greeting}</p>}
    </main>
  );
}

export default App;
