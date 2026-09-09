/**
 * Real-Postgres proof that {@link PostgresSessionPersistence} honors the
 * shared `SessionPersistence` seam contract, plus its live-write-path
 * behavior. Starts one Postgres container for the file (Testcontainers) and
 * gives every contract case its own schema inside it, so container startup
 * cost is paid once. Self-skips when Docker is unreachable, the same policy
 * this repo applies to real-provider-key e2e suites.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import pg from 'pg'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import PostgresSessionPersistence from '../src/index.ts'
import { LIVE_WRITE_BATCH_MAX_DELAY_MS } from '../src/storage.ts'
import { qualifiedTable, EVENT_TABLE, MESSAGE_TABLE } from '../src/schema.ts'
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

  describe('SessionPersistence: postgres derived tables', () => {
    it('projects the complete log generically and the four conversational/tool-call event types as message-node rows', async () => {
      const schema = freshSchema()
      const ctx = new Context()
      const fiber = await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      const id = SessionId(`derived-${randomUUID()}`)
      const callId = ToolCallId('call-1')
      const withNul = `has a ${String.fromCharCode(0)} byte`
      try {
        const handle = await ctx.sessionPersistence.create({
          version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), isSeeded: false,
        })
        await handle.append([
          { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
          {
            type: 'user/message', seq: SessionSeq(1), time: 2,
            data: createUserMessage({ content: [{ type: 'text', text: withNul }], source: { kind: 'user' } }),
          },
          {
            type: 'assistant/message', seq: SessionSeq(2), time: 3,
            data: {
              turn: 1, step: 1, stream: [],
              message: createMessage({
                role: 'assistant', content: [{ type: 'text', text: 'reply text' }],
                source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
              }),
              usage: { inputTokens: 3, outputTokens: 4 },
            },
          },
          { type: 'tool/call', seq: SessionSeq(3), time: 4, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{"cmd":"ls"}' } },
        ])
        await handle.close()

        const client = new Client({ connectionString })
        await client.connect()
        try {
          const events = await client.query(
            `SELECT seq, type FROM ${qualifiedTable(schema, EVENT_TABLE)} WHERE session_id = $1 ORDER BY seq`,
            [id],
          )
          expect(events.rows).toEqual([
            { seq: '0', type: 'turn/start' },
            { seq: '1', type: 'user/message' },
            { seq: '2', type: 'assistant/message' },
            { seq: '3', type: 'tool/call' },
          ])

          const messages = await client.query(
            `SELECT seq, role, content, model, tool_name, call_id, input_tokens, output_tokens
             FROM ${qualifiedTable(schema, MESSAGE_TABLE)} WHERE session_id = $1 ORDER BY seq`,
            [id],
          )
          // No row for the structural turn/start event: only the four conversational/tool-call types project here.
          expect(messages.rows).toEqual([
            {
              seq: '1', role: 'user', content: [{ type: 'text', text: 'has a � byte' }],
              model: null, tool_name: null, call_id: null, input_tokens: null, output_tokens: null,
            },
            {
              seq: '2', role: 'assistant', content: [{ type: 'text', text: 'reply text' }],
              model: 'mock', tool_name: null, call_id: null, input_tokens: '3', output_tokens: '4',
            },
            {
              seq: '3', role: 'tool_call', content: { name: 'bash', arguments: '{"cmd":"ls"}' },
              model: null, tool_name: 'bash', call_id: callId, input_tokens: null, output_tokens: null,
            },
          ])

          const search = await client.query(
            `SELECT seq FROM ${qualifiedTable(schema, MESSAGE_TABLE)} WHERE session_id = $1 AND content_tsv @@ to_tsquery('simple', 'reply')`,
            [id],
          )
          expect(search.rows.map((row: { seq: string }) => row.seq)).toEqual(['2'])
        } finally {
          await client.end()
        }
      } finally {
        await fiber.dispose()
        await dropSchema(connectionString, schema)
      }
    })
  })
} else {
  describe.skip('SessionPersistence contract: postgres (Docker unavailable)', () => {
    it('skipped: no reachable Docker daemon to run a Postgres container', () => {})
  })
}
