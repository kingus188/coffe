/**
 * Physical schema for the PostgreSQL session-persistence backend: three
 * tables (headers, the complete raw event log, and a derived per-message
 * projection) under one configurable Postgres schema, and the idempotent DDL
 * that ensures them on first use.
 * @module @deepseek-ai/dsh-session-persistence-postgres/schema
 */

import type { Pool } from 'pg'

/** Header row table: one row per stored session. */
export const HEADER_TABLE = 'dsh_session_header'
/** Event row table: one row per stored event, keyed by `(session_id, seq)`. */
export const EVENT_TABLE = 'dsh_session_event'
/** Derived message-node table: one row per conversational/tool-call event; see `./derived-message.ts`. */
export const MESSAGE_TABLE = 'dsh_session_message'

/** Quote one Postgres identifier (schema or table name) for safe interpolation. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Build the schema-qualified, quoted name for one table.
 * @param schemaName - the configured Postgres schema.
 * @param table - the bare table name ({@link HEADER_TABLE}, {@link EVENT_TABLE}, or {@link MESSAGE_TABLE}).
 * @returns the quoted `"schema"."table"` reference.
 */
export function qualifiedTable(schemaName: string, table: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(table)}`
}

/**
 * Create the configured schema (when not `public`) and its tables if absent.
 * Idempotent: safe to call from every backend instance at boot.
 * @param pool - the connection pool.
 * @param schemaName - the configured Postgres schema.
 */
export async function ensureSchema(pool: Pool, schemaName: string): Promise<void> {
  if (schemaName !== 'public') {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`)
  }
  const headerTable = qualifiedTable(schemaName, HEADER_TABLE)
  const eventTable = qualifiedTable(schemaName, EVENT_TABLE)
  const messageTable = qualifiedTable(schemaName, MESSAGE_TABLE)
  // `header`/`event` are `bytea` (raw UTF-8 JSON bytes), not `jsonb`: Postgres's
  // jsonb input parser refuses any text containing a NUL byte or a lone UTF-16
  // surrogate ("unsupported Unicode escape sequence" / "Unicode low surrogate
  // must follow a high surrogate"), which a JS string can validly hold and
  // JSONL faithfully stores. The seam's "lossless JSON data" invariant means
  // this backend must store whatever `materializeAppendBatch`/
  // `materializeCreateHeader` already validated, not re-validate it more
  // strictly than the seam requires. `dsh_session_message` below is a derived,
  // lossy-tolerant projection built from this same source, so its `jsonb`
  // content column sanitizes NUL bytes instead (`./derived-message.ts`).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${headerTable} (
      id text PRIMARY KEY,
      header bytea NOT NULL,
      inherited_event_count bigint NOT NULL,
      event_count bigint NOT NULL DEFAULT 0,
      revision bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${eventTable} (
      session_id text NOT NULL REFERENCES ${headerTable}(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      event bytea NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `)
  await ensureEventEnvelopeColumns(pool, eventTable)
  await ensureMessageTable(pool, headerTable, messageTable)
}

/**
 * Add the generic event-envelope columns (`type`, `event_time`) to an event
 * table that may already exist without them, so a schema created by an
 * earlier version of this backend upgrades in place. Split from the initial
 * `CREATE TABLE` so a fresh table and an upgraded one share one code path;
 * every statement is `IF NOT EXISTS`, so this is a no-op once applied. These
 * two columns cover the complete log generically; conversational content
 * lives in `dsh_session_message` instead (`./derived-message.ts`).
 * @param pool - the connection pool.
 * @param eventTable - the schema-qualified, quoted event table name.
 */
async function ensureEventEnvelopeColumns(pool: Pool, eventTable: string): Promise<void> {
  await pool.query(`
    ALTER TABLE ${eventTable}
      ADD COLUMN IF NOT EXISTS type text,
      ADD COLUMN IF NOT EXISTS event_time bigint
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_event_type_idx ON ${eventTable} (session_id, type)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_event_time_idx ON ${eventTable} (event_time)`)
}

/**
 * Create the derived per-message table and its indexes if absent. One row
 * per conversational or tool-call event (`user/message`, `assistant/message`,
 * `tool/call`, `tool/result`) — see `./derived-message.ts` for what populates
 * each column and why every other event type produces no row here.
 * @param pool - the connection pool.
 * @param headerTable - the schema-qualified, quoted header table name.
 * @param messageTable - the schema-qualified, quoted message table name.
 */
async function ensureMessageTable(pool: Pool, headerTable: string, messageTable: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${messageTable} (
      session_id text NOT NULL REFERENCES ${headerTable}(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      message_id text,
      role text NOT NULL,
      content jsonb,
      create_time bigint NOT NULL,
      model text,
      provider text,
      tool_name text,
      call_id text,
      input_tokens bigint,
      output_tokens bigint,
      total_tokens bigint,
      cache_read_tokens bigint,
      cache_write_tokens bigint,
      reasoning_tokens bigint,
      replaces_start_seq bigint,
      replaces_end_seq bigint,
      source_event_seqs bigint[],
      PRIMARY KEY (session_id, seq)
    )
  `)
  // A generated column's expression cannot be added in the same statement as
  // a fresh CREATE TABLE would already satisfy, but IF NOT EXISTS below still
  // keeps this idempotent across repeated boots. jsonb_to_tsvector walks the
  // whole `content` tree and indexes every string leaf (block text, tool
  // names/arguments, …) without a separate flattened text column.
  await pool.query(`
    ALTER TABLE ${messageTable}
      ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (jsonb_to_tsvector('simple', coalesce(content, '{}'::jsonb), '["string"]')) STORED
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_role_idx ON ${messageTable} (session_id, role)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_id_idx ON ${messageTable} (message_id) WHERE message_id IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_tool_name_idx ON ${messageTable} (tool_name) WHERE tool_name IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_call_id_idx ON ${messageTable} (call_id) WHERE call_id IS NOT NULL`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_content_idx ON ${messageTable} USING GIN (content jsonb_path_ops)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS dsh_session_message_content_tsv_idx ON ${messageTable} USING GIN (content_tsv)`)
}
