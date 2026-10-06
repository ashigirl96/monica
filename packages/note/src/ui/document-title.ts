import { useEffect } from 'react'

const APP_NAME = 'tania'

// タブを並べたときに見分けられるよう、開いているものの表示名を先に置く。
export function useDocumentTitle(name: string | null): void {
  useEffect(() => {
    document.title = name === null ? APP_NAME : `${name} · ${APP_NAME}`
  }, [name])
}
