export type ThemePref = 'system' | 'light' | 'dark'

// apps/web の index.html の描画前の script も同じ key と規則でテーマを当てる。
const STORAGE_KEY = 'monica-theme'

const darkSchemeQuery = () => matchMedia('(prefers-color-scheme: dark)')

export function themePref(): ThemePref {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

function apply(pref: ThemePref) {
  const resolved = pref === 'system' ? (darkSchemeQuery().matches ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = resolved
}

export function setThemePref(pref: ThemePref) {
  if (pref === 'system') {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, pref)
  }
  apply(pref)
}

export function initTheme(): () => void {
  apply(themePref())
  const media = darkSchemeQuery()
  const onChange = () => {
    if (themePref() === 'system') apply('system')
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
