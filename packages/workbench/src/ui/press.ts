import type { MouseEvent, PointerEvent } from 'react'

// マウスでは押した時点で動かしているので、click で動くのはキーボード（Enter・Space）の click だけにする。
export function keyboardClick(action: () => void) {
  return {
    onClick: (e: MouseEvent) => {
      if (e.detail === 0) action()
    },
  }
}

// WKWebView は trackpad の tap を up、down の順で届け、click は 1 つ前の tap の down と組んで共通の祖先に飛ぶので、押した要素に届く mousedown で動かす。
export function pressHandlers(action: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      // 押した後に focus を戻すと xterm が DECSET 1004 を立てた app に focus out と in を送るので、既定の動作を止める。
      e.preventDefault()
      if (e.button === 0) action()
    },
    ...keyboardClick(action),
  }
}

// 続く mousedown で button が focus を取ると、xterm が DECSET 1004 を立てた app に focus out と in を送るので、既定の動作を止める。
export function pointerPress(action: () => void) {
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      action()
    },
  }
}
