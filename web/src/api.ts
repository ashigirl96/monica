import type {
  DailyNoteCount,
  Explanation,
  LinkPreview,
  Note,
  NoteMention,
  NotePage,
  NoteSummary,
  NotesSettings,
  NotesToday,
  ProjectOption,
  SetNoteKind,
  UpdateNote,
} from "./types.gen";

export async function listExplanations(): Promise<Explanation[]> {
  const res = await fetch("/api/explanations");
  if (!res.ok) throw new Error(`Failed to list explanations: ${res.status}`);
  return res.json();
}

export async function getExplanation(id: string): Promise<Explanation> {
  const res = await fetch(`/api/explanations/${id}`);
  if (!res.ok) throw new Error(`Failed to get explanation: ${res.status}`);
  return res.json();
}

export async function deleteExplanation(id: string): Promise<void> {
  const res = await fetch(`/api/explanations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete explanation: ${res.status}`);
}

export async function createNote(): Promise<Note> {
  const res = await fetch("/api/notes", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create note: ${res.status}`);
  return res.json();
}

export async function listNotes(from: string, to: string): Promise<NoteSummary[]> {
  const res = await fetch(`/api/notes?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`Failed to list notes: ${res.status}`);
  return res.json();
}

export async function listProjectNotes(projectId: string, offset: number): Promise<NotePage> {
  const params = new URLSearchParams({ project_id: projectId, offset: String(offset) });
  const res = await fetch(`/api/notes/by-project?${params}`);
  if (!res.ok) throw new Error(`Failed to list project notes: ${res.status}`);
  return res.json();
}

export async function getNote(id: string): Promise<Note> {
  const res = await fetch(`/api/notes/${id}`);
  if (!res.ok) throw new Error(`Failed to get note: ${res.status}`);
  return res.json();
}

export async function updateNote(id: string, update: UpdateNote, keepalive = false): Promise<void> {
  const res = await fetch(`/api/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
    keepalive,
  });
  if (!res.ok) throw new Error(`Failed to save note: ${res.status}`);
}

export async function setNoteKind(id: string, kind: SetNoteKind): Promise<Note> {
  const res = await fetch(`/api/notes/${id}/kind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(kind),
  });
  if (!res.ok) throw new Error(`Failed to change note kind: ${res.status}`);
  return res.json();
}

export async function getNotesToday(): Promise<NotesToday> {
  const res = await fetch("/api/notes/today");
  if (!res.ok) throw new Error(`Failed to load today: ${res.status}`);
  return res.json();
}

export async function getNotesSettings(): Promise<NotesSettings> {
  const res = await fetch("/api/settings/notes");
  if (!res.ok) throw new Error(`Failed to load notes settings: ${res.status}`);
  return res.json();
}

export async function putNotesSettings(settings: NotesSettings): Promise<NotesSettings> {
  const res = await fetch("/api/settings/notes", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error(`Failed to save notes settings: ${res.status}`);
  return res.json();
}

export async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`/api/notes/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete note: ${res.status}`);
}

export async function restoreNote(id: string): Promise<Note> {
  const res = await fetch(`/api/notes/${id}/restore`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to restore note: ${res.status}`);
  return res.json();
}

export async function dailyNoteCounts(from: string, to: string): Promise<DailyNoteCount[]> {
  const res = await fetch(`/api/notes/daily-counts?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`Failed to load note counts: ${res.status}`);
  return res.json();
}

export async function listProjects(): Promise<ProjectOption[]> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`);
  return res.json();
}

export async function searchNoteMentions(q: string): Promise<NoteMention[]> {
  const res = await fetch(`/api/notes/mentions?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Failed to search note mentions: ${res.status}`);
  return res.json();
}

// noteId → mention の解決結果を Promise ごと共有する（同一 doc 内の重複 mention を
// 1 リクエストに畳む in-flight 共有兼キャッシュ）。null = dangling（404 も通信失敗も
// 同じ扱いにして NodeView 側の分岐を増やさない）。
const noteMentionCache = new Map<string, Promise<NoteMention | null>>();

export function resolveNoteMention(id: string): Promise<NoteMention | null> {
  const cached = noteMentionCache.get(id);
  if (cached) return cached;
  const promise = (async (): Promise<NoteMention | null> => {
    try {
      const res = await fetch(`/api/notes/mentions/${id}`);
      if (!res.ok) return null;
      return (await res.json()) as NoteMention;
    } catch {
      return null;
    }
  })();
  noteMentionCache.set(id, promise);
  return promise;
}

/** ノートを開き直すたびに呼び、mention の表示名を最新のタイトルに追従させる */
export function clearNoteMentionCache(): void {
  noteMentionCache.clear();
}

// 失敗を null で返す: 呼び手（link-menu）はプレーンリンクへのフォールバックとして扱う
export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  try {
    const res = await fetch(`/api/ogp?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
