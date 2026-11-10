import { expect, test } from 'bun:test'

import { playgroundEnv } from './playground.ts'

test('the Playground env puts every tool under env of the Study dir and names the compose project by the Study id', () => {
  expect(playgroundEnv('/m/studies/study-0190', 'study-0190')).toEqual({
    MONICA_STUDY_DIR: '/m/studies/study-0190',
    MONICA_STUDY_ID: 'study-0190',
    MISE_DATA_DIR: '/m/studies/study-0190/env/mise',
    NPM_CONFIG_PREFIX: '/m/studies/study-0190/env/npm',
    npm_config_cache: '/m/studies/study-0190/env/cache/npm',
    CARGO_HOME: '/m/studies/study-0190/env/cargo',
    COMPOSE_PROJECT_NAME: 'study-0190',
  })
})
