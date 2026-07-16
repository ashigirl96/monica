import { atom } from "jotai";

// Space 切替でコンテンツが unmount されても文書が消えないよう、
// ProseMirror doc の JSON を in-memory で保持する（永続化はしない）。
export const journalDocAtom = atom<unknown | null>(null);
