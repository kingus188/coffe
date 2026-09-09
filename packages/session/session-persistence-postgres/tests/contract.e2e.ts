/**
 * Real-Postgres proof that {@link PostgresSessionPersistence} honors the
 * shared `SessionPersistence` seam contract, plus its live-write-path
 * behavior. Starts one Postgres container for the file (Testcontainers) and
 * gives every contract case its own schema inside it, so container startup
 * cost is paid once. Self-skips when Docker is unreachable, the same policy
 * this repo applies to real-provider-key e2e suites.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import pg from 'pg'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import PostgresSessionPersistence from '../src/index.ts'
import { LIVE_WRITE_BATCH_MAX_DELAY_MS } from '../src/storage.ts'
import { runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'

const { Client } = pg

let container: StartedPostgreSqlContainer | undefined
try {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
} catch {
  // Docker unreachable in this environment; the suite below self-skips.
  container = undefined
}

afterAll(async () => {
  await container?.stop()
})

/** A fresh Postgres schema name for one contract case, isolated within the shared container. */
function freshSchema(): string {
  return `dsh_test_${randomUUID().replaceAll('-', '_')}`
}

/** Drop one test's schema so the shared container does not accumulate cruft across cases. */
async function dropSchema(connectionString: string, schema: string): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await client.end()
  }
}

if (container !== undefined) {
  const connectionString = container.getConnectionUri()

  runPersistenceContract('postgres', async () => {
    const schema = freshSchema()
    const instance = async (): Promise<{ persistence: SessionPersistence; dispose: () => Promise<void> }> => {
      const ctx = new Context()
      const fiber = await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      return {
        persistence: ctx.sessionPersistence,
        dispose: async () => { await fiber.dispose() },
      }
    }
    const primary = await instance()
    return {
      persistence: primary.persistence,
      dispose: async () => {
        await primary.dispose()
        await dropSchema(connectionString, schema)
      },
      reopen: instance,
      // No corruptTail: Postgres transactions are atomic, so this backend has
      // no torn-tail failure mode for the shared suite to exercise.
    }
  })

  runLiveWritePathContract('postgres', LIVE_WRITE_BATCH_MAX_DELAY_MS, async () => {
    const schema = freshSchema()
    const mount = async (): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      return ctx
    }
    return { ctx: await mount(), remount: mount }
  })
} else {
  describe.skip('SessionPersistence contract: postgres (Docker unavailable)', () => {
    it('skipped: no reachable Docker daemon to run a Postgres container', () => {})
  })
}
