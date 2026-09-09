/**
 * Real-Postgres proof that {@link PostgresSessionPersistence} honors the
 * shared `SessionPersistence` seam contract, plus its live-write-path
 * behavior. Starts one Postgres container for the file (Testcontainers) and
 * gives every contract case its own schema inside it, so container startup
 * cost is paid once. Self-skips when Docker is unreachable, the same policy
 * this repo applies to real-provider-key e2e suites.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import pg from 'pg'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import PostgresSessionPersistence from '../src/index.ts'
import { LIVE_WRITE_BATCH_MAX_DELAY_MS } from '../src/storage.ts'
import { ensureSchema, qualifiedTable, EVENT_TABLE, HEADER_TABLE, MESSAGE_TABLE } from '../src/schema.ts'
import { runPersistenceContract } from '../../session-persistence/tests/contract.ts'
import { runLiveWritePathContract } from '../../session-persistence/tests/live-write-contract.ts'

const { Client, Pool } = pg

let container: StartedPostgreSqlContainer | undefined
try {
  container = await new PostgreSqlContainer(process.env.DSH_POSTGRES_TEST_IMAGE ?? 'postgres:18-alpine').withDatabase('coffe').start()
} catch (error) {
  if (process.env.DSH_POSTGRES_REQUIRE_DOCKER === '1') throw error
  if (!(error instanceof Error) || error.message !== 'Could not find a working container runtime strategy') throw error
  // No container runtime was found; image, startup, and SQL failures remain test failures.
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

  describe('Agent runtime schema upgrade', () => {
    it.each(['dsh', 'agent', 'dsh-base'] as const)('renames %s tables in place and preserves history, indexes, foreign keys, and other plugin data', async (generation) => {
      const schema = freshSchema()
      const client = new Client({ connectionString })
      const ctx = new Context()
      try {
        await client.connect()
        await client.query(`CREATE SCHEMA "${schema}"`)
        await client.query(`SET search_path TO "${schema}"`)
        const names = generation === 'agent'
          ? { header: 'agent_session', event: 'agent_session_event', message: 'agent_message' }
          : { header: 'dsh_session_header', event: 'dsh_session_event', message: 'dsh_session_message' }
        const sql = await readFile(new URL('./fixtures/legacy-schema.sql', import.meta.url), 'utf8')
        await client.query(sql.replaceAll('dsh_session_header', names.header).replaceAll('dsh_session_event', names.event).replaceAll('dsh_session_message', names.message))
        if (generation === 'dsh-base') {
          await client.query('DROP TABLE dsh_session_message')
          await client.query('ALTER TABLE dsh_session_event DROP COLUMN type, DROP COLUMN event_time')
        }
        await client.query('CREATE TABLE coffe_task (id integer PRIMARY KEY)')
        await client.query('INSERT INTO coffe_task VALUES (42)')
        const id = SessionId(randomUUID())
        const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false }
        const event: SessionEvent<'user/message'> = {
          type: 'user/message', seq: SessionSeq(0), time: 1,
          data: createUserMessage({ content: [{ type: 'text', text: 'retained history' }], source: { kind: 'user' } }),
        }
        await client.query(`INSERT INTO ${names.header} (id, header, inherited_event_count, event_count, revision) VALUES ($1, $2, 0, 1, 1)`, [id, Buffer.from(JSON.stringify(header))])
        await client.query(`INSERT INTO ${names.event} (session_id, seq, event) VALUES ($1, 0, $2)`, [id, Buffer.from(JSON.stringify(event))])
        if (generation !== 'dsh-base') {
          await client.query(`INSERT INTO ${names.message} (session_id, seq, message_id, role, content, create_time) VALUES ($1, 0, $2, $3, $4, 1)`, [id, event.data.id, 'user', JSON.stringify(event.data.content)])
        }
        const before = await client.query('SELECT oid FROM pg_class WHERE relnamespace = $1::regnamespace ORDER BY oid', [schema])

        await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
        const handle = await ctx.sessionPersistence.open(id, 'write')
        expect((await handle.read()).events).toEqual([event])
        const after = await client.query('SELECT oid FROM pg_class WHERE relnamespace = $1::regnamespace ORDER BY oid', [schema])
        expect(after.rows).toEqual(generation === 'dsh-base' ? expect.arrayContaining(before.rows) : before.rows)
        expect((await client.query("SELECT seq FROM coffe_message WHERE content_tsv @@ to_tsquery('simple', 'retained')")).rows).toEqual(generation === 'dsh-base' ? [] : [{ seq: '0' }])
        expect((await client.query('SELECT * FROM coffe_task')).rows).toEqual([{ id: 42 }])
        expect((await client.query("SELECT relname FROM pg_class WHERE relnamespace = $1::regnamespace AND (relname LIKE 'dsh_session_%' OR relname LIKE 'agent_%')", [schema])).rows).toEqual([])
        expect((await client.query("SELECT conname FROM pg_constraint WHERE connamespace = $1::regnamespace AND (conname LIKE 'dsh_session_%' OR conname LIKE 'agent_%')", [schema])).rows).toEqual([])
        await handle.append([{ ...event, seq: SessionSeq(1) }])
        await handle.close()
        expect((await client.query('SELECT event_count, revision FROM coffe_session WHERE id = $1', [id])).rows).toEqual([{ event_count: '2', revision: '2' }])
        expect((await client.query('SELECT count(*) FROM coffe_message')).rows).toEqual([{ count: generation === 'dsh-base' ? '1' : '2' }])
        await expect(client.query('INSERT INTO coffe_session_event (session_id, seq, event) VALUES ($1, 0, $2)', ['missing', Buffer.from('{}')])).rejects.toMatchObject({ code: '23503' })

        await client.query('ALTER TABLE coffe_session RENAME CONSTRAINT coffe_session_pkey TO dsh_session_header_pkey')
        const repair = new Pool({ connectionString })
        try {
          await ensureSchema(repair, schema)
        } finally {
          await repair.end()
        }
        expect((await client.query("SELECT conname FROM pg_constraint WHERE connamespace = $1::regnamespace AND conname LIKE 'dsh_%'", [schema])).rows).toEqual([])
      } finally {
        await ctx.fiber.dispose()
        await client.end()
        await dropSchema(connectionString, schema)
      }
    })

    it.each(['table', 'index', 'legacy'] as const)('rejects colliding %s names without partially renaming the schema', async (collision) => {
      const schema = freshSchema()
      const client = new Client({ connectionString })
      const pool = new Pool({ connectionString })
      try {
        await client.connect()
        await client.query(`CREATE SCHEMA "${schema}"`)
        await client.query(`SET search_path TO "${schema}"`)
        await client.query(await readFile(new URL('./fixtures/legacy-schema.sql', import.meta.url), 'utf8'))
        if (collision === 'table') {
          await client.query('CREATE TABLE coffe_message (id integer PRIMARY KEY)')
          await expect(ensureSchema(pool, schema)).rejects.toThrow('conflicting session tables: dsh_session_message, coffe_message')
        } else if (collision === 'legacy') {
          await client.query('CREATE TABLE agent_message (id integer PRIMARY KEY)')
          await expect(ensureSchema(pool, schema)).rejects.toThrow('conflicting session tables: dsh_session_message, agent_message')
        } else {
          await client.query('CREATE INDEX coffe_message_role_idx ON dsh_session_header (id)')
          await expect(ensureSchema(pool, schema)).rejects.toMatchObject({ code: '42P07' })
        }
        expect((await client.query("SELECT to_regclass('dsh_session_header')::text AS legacy, to_regclass('coffe_session')::text AS current")).rows).toEqual([{ legacy: 'dsh_session_header', current: null }])
      } finally {
        await pool.end()
        await client.end()
        await dropSchema(connectionString, schema)
      }
    })

    it('serializes simultaneous first use from independent connections and remains repeatable', async () => {
      const schema = freshSchema()
      const blocker = new Client({ connectionString })
      const applicationName = `schema-upgrade-${randomUUID()}`
      const first = new Pool({ connectionString, application_name: applicationName, max: 1 })
      const second = new Pool({ connectionString, application_name: applicationName, max: 1 })
      let upgrades: Promise<PromiseSettledResult<void>[]> | undefined
      try {
        await blocker.connect()
        await blocker.query('BEGIN')
        await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['agent-runtime:session-schema', schema])
        upgrades = Promise.allSettled([ensureSchema(first, schema), ensureSchema(second, schema)])
        await vi.waitFor(async () => {
          // Activity snapshots are cached inside the blocker's open transaction.
          await blocker.query('SELECT pg_stat_clear_snapshot()')
          const waiting = await blocker.query("SELECT count(*) FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [applicationName])
          expect(waiting.rows).toEqual([{ count: '2' }])
        }, { timeout: 10_000 })
        await blocker.query('ROLLBACK')
        expect(await upgrades).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }])
        await ensureSchema(first, schema)
        const tables = await blocker.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])
        expect(tables.rows.map((row: { tablename: string }) => row.tablename)).toEqual(['coffe_message', 'coffe_session', 'coffe_session_event'])
      } finally {
        await blocker.query('ROLLBACK')
        await upgrades
        await first.end()
        await second.end()
        await blocker.end()
        await dropSchema(connectionString, schema)
      }
    })
  })

  describe('SessionPersistence: postgres derived tables', () => {
    it('projects the complete log generically and the four conversational/tool-call event types as message-node rows', async () => {
      const schema = freshSchema()
      const ctx = new Context()
      const fiber = await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      const id = SessionId(`derived-${randomUUID()}`)
      const callId = ToolCallId('call\0\ud800')
      const withNul = 'has a \0 byte and \ud800 surrogate, 中文 \ud83d\ude00'
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
          {
            type: 'tool/result', seq: SessionSeq(4), time: 5,
            data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false }) },
          },
        ])
        const stored = await handle.read()
        expect(stored.events[1]).toMatchObject({ data: { content: [{ type: 'text', text: withNul }] } })
        expect(stored.events[3]).toMatchObject({ data: { callId } })
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
            { seq: '4', type: 'tool/result' },
          ])

          const messages = await client.query(
            `SELECT seq, role, content, model, tool_name, call_id, input_tokens, output_tokens
             FROM ${qualifiedTable(schema, MESSAGE_TABLE)} WHERE session_id = $1 ORDER BY seq`,
            [id],
          )
          // No row for the structural turn/start event: only the four conversational/tool-call types project here.
          expect(messages.rows).toEqual([
            {
              seq: '1', role: 'user', content: [{ type: 'text', text: 'has a � byte and � surrogate, 中文 \ud83d\ude00' }],
              model: null, tool_name: null, call_id: null, input_tokens: null, output_tokens: null,
            },
            {
              seq: '2', role: 'assistant', content: [{ type: 'text', text: 'reply text' }],
              model: 'mock', tool_name: null, call_id: null, input_tokens: '3', output_tokens: '4',
            },
            {
              seq: '3', role: 'tool_call', content: { name: 'bash', arguments: '{"cmd":"ls"}' },
              model: null, tool_name: 'bash', call_id: 'call��', input_tokens: null, output_tokens: null,
            },
            {
              seq: '4', role: 'tool_result',
              content: [{ type: 'tool-result', toolCallId: 'call��', content: [{ type: 'text', text: 'done' }], isError: false }],
              model: null, tool_name: null, call_id: 'call��', input_tokens: null, output_tokens: null,
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

    it.each([
      { kind: 'structural', count: 17_000 },
      { kind: 'message', count: 3_700 },
    ] as const)('persists a $kind append exceeding one Bind parameter list', async ({ kind, count }) => {
      const schema = freshSchema()
      const ctx = new Context()
      const fiber = await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      try {
        const id = SessionId(randomUUID())
        const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
        const events: SessionEvent[] = Array.from({ length: count }, (_, seq) => kind === 'structural'
          ? { type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: seq + 1 } }
          : { type: 'user/message', seq: SessionSeq(seq), time: seq, data: createUserMessage({ content: [{ type: 'text', text: `message ${seq}` }], source: { kind: 'user' } }) })
        await handle.append(events)
        expect((await handle.read()).events).toEqual(events)
        const client = new Client({ connectionString })
        await client.connect()
        try {
          const header = await client.query(`SELECT event_count, revision FROM ${qualifiedTable(schema, HEADER_TABLE)} WHERE id = $1`, [id])
          expect(header.rows).toEqual([{ event_count: String(count), revision: '1' }])
          const messages = await client.query(`SELECT count(*) FROM ${qualifiedTable(schema, MESSAGE_TABLE)} WHERE session_id = $1`, [id])
          expect(messages.rows).toEqual([{ count: kind === 'message' ? String(count) : '0' }])
        } finally {
          await client.end()
        }
      } finally {
        await fiber.dispose()
        await dropSchema(connectionString, schema)
      }
    })

    it.each([false, true])('rolls back every table when a later message insert fails (materialized: %s)', async (materialized) => {
      const schema = freshSchema()
      const ctx = new Context()
      const fiber = await ctx.plugin(PostgresSessionPersistence, { connectionString, schema })
      const client = new Client({ connectionString })
      try {
        await client.connect()
        const id = SessionId(randomUUID())
        const handle = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
        if (materialized) await handle.flush()
        await client.query(`ALTER TABLE ${qualifiedTable(schema, MESSAGE_TABLE)} ADD CONSTRAINT test_reject_tail CHECK (seq < 3699)`)
        const events: SessionEvent[] = Array.from({ length: 3_700 }, (_, seq) => ({
          type: 'user/message', seq: SessionSeq(seq), time: seq,
          data: createUserMessage({ content: [], source: { kind: 'user' } }),
        }))
        await expect(handle.append(events)).rejects.toThrow('test_reject_tail')
        for (const table of [EVENT_TABLE, MESSAGE_TABLE]) {
          const result = await client.query(`SELECT count(*) FROM ${qualifiedTable(schema, table)}`)
          expect(result.rows).toEqual([{ count: '0' }])
        }
        const header = await client.query(`SELECT event_count, revision FROM ${qualifiedTable(schema, HEADER_TABLE)} WHERE id = $1`, [id])
        expect(header.rows).toEqual(materialized ? [{ event_count: '0', revision: '0' }] : [])
      } finally {
        await client.end()
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
