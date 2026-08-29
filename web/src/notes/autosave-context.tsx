import { createContext, type ReactNode, useContext } from "react";
import { type Autosave, useAutosave } from "./use-autosave";

const AutosaveContext = createContext<Autosave | null>(null);

/** autosave を router より上に置く。ページを跨いでも版台帳・pending・競合台帳が生き残るので、
 * note を離れた後に返った 409 が行き場を失わない。 */
export function AutosaveProvider({ children }: { children: ReactNode }) {
  const autosave = useAutosave();
  return <AutosaveContext.Provider value={autosave}>{children}</AutosaveContext.Provider>;
}

export function useAutosaveContext(): Autosave {
  const autosave = useContext(AutosaveContext);
  if (autosave === null) throw new Error("useAutosaveContext requires AutosaveProvider");
  return autosave;
}
