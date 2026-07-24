import type {
  Asset,
  DailyNoteCount,
  EssayStatus,
  Explanation,
  LinkPreview,
  Note,
  NoteBlock,
  NoteMention,
  NotePage,
  NoteSummary,
  NotesSettings,
  NotesToday,
  ProjectOption,
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

export async function listProjectNotes(projectId: string, offset: number): Promise<NotePage> {
  const params = new URLSearchParams({ project_id: projectId, offset: String(offset) });
  const res = await fetch(`/api/notes/by-project?${params}`);
  if (!res.ok) throw new Error(`Failed to list project notes: ${res.status}`);
  return res.json();
}

/** project の primary note の get-or-create（冪等）。初オープン時に lazy 作成される。
 * project_id は "owner/repo" 形式でスラッシュを含むため query で渡す。 */
export async function primaryNote(projectId: string): Promise<Note> {
  const params = new URLSearchParams({ project_id: projectId });
  const res = await fetch(`/api/notes/project/primary?${params}`, { method: "PUT" });
  if (!res.ok) throw new Error(`Failed to open primary note: ${res.status}`);
  return res.json();
}

/** ⌥N: 現 project の新規 note。project_id は body で渡す。 */
export async function createProjectNote(projectId: string): Promise<Note> {
  const res = await fetch("/api/notes/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok) throw new Error(`Failed to create project note: ${res.status}`);
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

/** daily が存在する全日付（範囲指定なし・date 昇順）。/daily サイドバーの巡回リスト用 */
export async function dailyNoteDates(): Promise<DailyNoteCount[]> {
  const res = await fetch("/api/notes/daily-counts?kind=daily");
  if (!res.ok) throw new Error(`Failed to load daily dates: ${res.status}`);
  return res.json();
}

/** date の daily note の get-or-create（冪等）。開く = 作る。 */
export async function getDailyNote(date: string): Promise<Note> {
  const res = await fetch(`/api/notes/daily/${date}`, { method: "PUT" });
  if (!res.ok) throw new Error(`Failed to open daily note: ${res.status}`);
  return res.json();
}

/** 全 essay（全 status、updated_at 降順）。/essays 一覧とエディタサイドバーの共有ソース */
export async function listEssays(): Promise<NoteSummary[]> {
  const res = await fetch("/api/notes/essays");
  if (!res.ok) throw new Error(`Failed to list essays: ${res.status}`);
  return res.json();
}

export async function createEssay(): Promise<Note> {
  const res = await fetch("/api/notes/essays", { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create essay: ${res.status}`);
  return res.json();
}

export async function setEssayStatus(id: string, status: EssayStatus): Promise<Note> {
  const res = await fetch(`/api/notes/${id}/status`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`Failed to change essay status: ${res.status}`);
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

export async function renderNoteMarkdown(content: unknown): Promise<string> {
  const res = await fetch("/api/notes/markdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Failed to render markdown: ${res.status}`);
  return res.text();
}

// null = dangling（404 も通信失敗も同じ扱いにして NodeView 側の分岐を増やさない）。
// キャッシュはここでは持たず、埋め込み側がエディタの寿命に合わせてスコープする。
export async function resolveNoteMention(id: string): Promise<NoteMention | null> {
  try {
    const res = await fetch(`/api/notes/mentions/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as NoteMention;
  } catch {
    return null;
  }
}

// synced block（transclusion）の解決。404 = dangling は null、通信エラーは throw
// （NodeView 側で「削除された」表示と「再試行可能なエラー」表示を分けるため）。
export async function getNoteBlock(noteId: string, blockId: string): Promise<NoteBlock | null> {
  const res = await fetch(`/api/notes/${noteId}/blocks/${blockId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to resolve synced block: ${res.status}`);
  return (await res.json()) as NoteBlock;
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

// 画像 File を raw body で POST。失敗は null（呼び手は ObjectURL 表示のまま upload を諦める）
export async function uploadImageAsset(file: File): Promise<Asset | null> {
  try {
    const res = await fetch("/api/assets", {
      method: "POST",
      headers: { "content-type": file.type },
      body: file,
    });
    if (!res.ok) return null;
    return (await res.json()) as Asset;
  } catch {
    return null;
  }
}

// 外部画像 URL を backend が fetch してローカル asset 化。失敗は null（外部 URL のまま残す）
export async function importImageAsset(url: string): Promise<Asset | null> {
  try {
    const res = await fetch("/api/assets/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return null;
    return (await res.json()) as Asset;
  } catch {
    return null;
  }
}
