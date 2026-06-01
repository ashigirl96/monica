import { useState } from "react";
import { cn } from "@/lib/utils";
import { githubSignOut, openExternal, saveGithubToken } from "./api";
import type { GithubAuthStatus } from "./types";

const TOKEN_CREATE_URL = "https://github.com/settings/personal-access-tokens/new";

interface GithubAuthPanelProps {
  status: GithubAuthStatus | null;
  reauthRequired: boolean;
  onChanged: () => void;
}

export function GithubAuthPanel({ status, reauthRequired, onChanged }: GithubAuthPanelProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean(status?.authenticated) && !reauthRequired;
  const isBlank = token.trim().length === 0;

  const save = async () => {
    if (saving || isBlank) return;
    setSaving(true);
    setError(null);
    try {
      await saveGithubToken(token.trim());
      setToken("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await githubSignOut();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (connected) {
    return (
      <div className="flex items-center justify-between border-b border-border/60 bg-card/20 px-5 py-2 text-[11px] text-muted-foreground">
        <span>GitHub connected{status?.login ? ` as ${status.login}` : ""}</span>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded px-2 py-1 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="border-b border-border/60 bg-card/20 px-5 py-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="text-foreground">
          {reauthRequired
            ? "GitHub token is missing or invalid — PR sync is paused."
            : "Connect GitHub to sync linked pull requests."}
        </span>
        <button
          type="button"
          onClick={() => void openExternal(TOKEN_CREATE_URL)}
          className="rounded px-2 py-1 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          Create a token
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="Paste a GitHub token (repo: Pull requests / Contents / Issues = Read)"
          className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none focus:border-foreground/40"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || isBlank}
          className={cn(
            "rounded border border-border/60 px-3 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/10",
            (saving || isBlank) && "opacity-50",
          )}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="mt-1 font-mono text-[11px] text-destructive">{error}</div>}
    </div>
  );
}
