export class FakeStorage {
  readonly items = new Map<string, string>()
  constructor(items: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(items)) this.items.set(key, value)
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

/** bun test に無い localStorage・matchMedia・document を、見た目の設定が触る分だけ globals に置く。 */
export function openPage(
  storage: FakeStorage,
  { systemDark = false } = {},
): { dataset: DOMStringMap } {
  const dataset: DOMStringMap = {}
  Object.assign(globalThis, {
    localStorage: storage,
    matchMedia: (query: string) => {
      if (query !== '(prefers-color-scheme: dark)')
        throw new Error(`unexpected media query: ${query}`)
      return { matches: systemDark, addEventListener() {}, removeEventListener() {} }
    },
    document: { documentElement: { dataset, style: { setProperty() {} } } },
  })
  return { dataset }
}

export function closePage(): void {
  for (const name of ['localStorage', 'matchMedia', 'document']) {
    Reflect.deleteProperty(globalThis, name)
  }
}
