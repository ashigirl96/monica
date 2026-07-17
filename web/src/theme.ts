export type ThemePref = "system" | "light" | "dark";

const STORAGE_KEY = "monica-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function themePref(): ThemePref {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

function apply(pref: ThemePref) {
  const resolved = pref === "system" ? (media.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
}

export function setThemePref(pref: ThemePref) {
  if (pref === "system") {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, pref);
  }
  apply(pref);
}

export function initTheme() {
  apply(themePref());
  media.addEventListener("change", () => {
    if (themePref() === "system") apply("system");
  });
}
