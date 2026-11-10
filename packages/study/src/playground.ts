import { join } from 'node:path'

export function playgroundEnv(studyDir: string, studyId: string): { [key: string]: string } {
  const env = join(studyDir, 'env')
  return {
    MONICA_STUDY_DIR: studyDir,
    MONICA_STUDY_ID: studyId,
    MISE_DATA_DIR: join(env, 'mise'),
    NPM_CONFIG_PREFIX: join(env, 'npm'),
    npm_config_cache: join(env, 'cache/npm'),
    CARGO_HOME: join(env, 'cargo'),
    COMPOSE_PROJECT_NAME: studyId,
  }
}
