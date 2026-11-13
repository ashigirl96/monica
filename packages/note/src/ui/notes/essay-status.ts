import type { EssayStatus } from '../../contract.ts'

/** ⌃W・StatusChip・一覧の右クリックで送る status。procedure は toggle ではなく値を受ける。 */
export function nextEssayStatus(current: EssayStatus): EssayStatus {
  return current === 'writing' ? 'finished' : 'writing'
}
