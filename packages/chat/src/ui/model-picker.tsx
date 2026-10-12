import type { Effort } from '../contract.ts'
import type { ChatStore, Picker } from './chat-store.ts'

const SELECT_CLASS =
  'h-7 max-w-[9rem] min-w-0 cursor-pointer truncate rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground'

/** 入力欄の左に置く model と effort の選択。effort を持たない model では effort を出さない。 */
export function ModelPicker({ store, picker }: { store: ChatStore; picker: Picker }) {
  const chosen = picker.models.find(({ value }) => value === picker.model)
  return (
    <>
      <select
        aria-label="model"
        title={chosen?.description}
        className={SELECT_CLASS}
        value={picker.model}
        onChange={(event) => store.chooseModel(event.target.value)}
      >
        {picker.models.map(({ value, displayName, description }) => (
          <option key={value} value={value} title={description}>
            {displayName}
          </option>
        ))}
      </select>
      {picker.effort && (
        <select
          aria-label="effort"
          className={SELECT_CLASS}
          value={picker.effort}
          onChange={(event) => store.chooseEffort(event.target.value as Effort)}
        >
          {picker.efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      )}
    </>
  )
}
