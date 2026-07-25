/** ⌥ 単独 / ⌃ 単独の修飾キー判定。web は画面ごとに capture phase の keydown を張る流儀なので、
 * どの画面でも修飾キーの方針が揃うようここに集める。 */
export function altOnly(e: KeyboardEvent): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
}

export function ctrlOnly(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/** ⇧ の有無を問わない ⌥。⌥X と ⇧⌥X を 1 つの keydown で正順 / 逆順に振り分ける用途。
 * 判定後に e.shiftKey を見て向きを決める。 */
export function altAllowingShift(e: KeyboardEvent): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey;
}
