import type { StudyClient } from './client.ts'

/** 新しい Study を作って最初の一言を送る。send だけ失敗した Study は覚えて、次はそこへ送る。 */
export function createStudyStarter(client: Pick<StudyClient, 'start' | 'send'>) {
  let unsent: string | undefined
  return {
    async begin(text: string): Promise<string> {
      const id = unsent ?? (await client.start({})).id
      unsent = id
      await client.send({ id, text })
      unsent = undefined
      return id
    },
  }
}
