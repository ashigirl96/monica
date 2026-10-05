import type { CurrentOutput, ListItem } from '../contract.ts'

// task.current は closed な Task の Run も引くので、close を頼んだ claude の Tab にも項目を出さない。
// task.list は track した順に返すので、新しい順にするには逆にする。
export function attachChoices(tasks: ListItem[], tabTask: CurrentOutput | null): ListItem[] | null {
  return tabTask?.source === 'run' ? null : tasks.toReversed()
}
