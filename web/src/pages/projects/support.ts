const LAST_PROJECT_KEY = "monica-projects-last";

/** 最後に開いた project id。web には server 永続の ui-state 機構が無いので localStorage に置く
 * （theme / density と同じ経路）。値は "owner/repo" 形式。 */
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setLastProject(projectId: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // private mode 等で書けなくても復元が効かないだけなので握りつぶす
  }
}

export function clearLastProject() {
  try {
    localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // 同上
  }
}
