import { expect, test } from 'bun:test'

import type { Model } from '../contract.ts'
import { pickerOf } from './model-picker.tsx'

const models: Model[] = [
  { value: 'default', displayName: 'Default', description: '' },
  {
    value: 'opus',
    displayName: 'Opus',
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high'],
  },
  { value: 'old', displayName: 'Old', description: '', supportsEffort: false },
]

test('nothing saved shows the default row and leaves the model and effort out', () => {
  expect(pickerOf(models, {})).toMatchObject({ entry: models[0], efforts: [], choice: {} })
})

test('a saved model and effort it offers go to send', () => {
  expect(pickerOf(models, { model: 'opus', effort: 'high' }).choice).toEqual({
    model: 'opus',
    effort: 'high',
  })
})

test('an effort the model does not offer and a model gone from the list are left out', () => {
  expect(pickerOf(models, { model: 'opus', effort: 'max' }).choice).toEqual({ model: 'opus' })
  expect(pickerOf(models, { model: 'old', effort: 'low' }).choice).toEqual({ model: 'old' })
  expect(pickerOf(models, { model: 'gone' }).choice).toEqual({})
})
