/**
 * Physical schema for the PostgreSQL session-persistence backend: two tables
 * (headers, events) under one configurable Postgres schema, and the
 * idempotent DDL that ensures them on first use.
 * @module @deepseek-ai/dsh-session-persistence-postgres/schema
 */

import type { Pool } from 'pg'

/** Header row table: one row per stored session. */
export const HEADER_TABLE = 'dsh_session_header'
/** Event row table: one row per stored event, keyed by `(session_id, seq)`. */
export const EVENT_TABLE = 'dsh_session_event'

/** Quote one Postgres identifier (schema or table name) for safe interpolation. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Build the schema-qualified, quoted name for one table.
 * @param schemaName - the configured Postgres schema.
 * @param table - the bare table name ({@link HEADER_TABLE} or {@link EVENT_TABLE}).
 * @returns the quoted `"schema"."table"` reference.
 */
export function qualifiedTable(schemaName: string, table: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(table)}`
}

/**
 * Create the configured schema (when not `public`) and its two tables if
 * absent. Idempotent: safe to call from every backend instance at boot.
 * @param pool - the connection pool.
 * @param schemaName - the configured Postgres schema.
 */
export async function ensureSchema(pool: Pool, schemaName: string): Promise<void> {
  if (schemaName !== 'public') {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`)
  }
  const headerTable = qualifiedTable(schemaName, HEADER_TABLE)
  const eventTable = qualifiedTable(schemaName, EVENT_TABLE)
  // `header`/`event` are `bytea` (raw UTF-8 JSON bytes), not `jsonb`: Postgres's
  // jsonb input parser refuses any text containing a NUL byte or a lone UTF-16
  // surrogate ("unsupported Unicode escape sequence" / "Unicode low surrogate
  // must follow a high surrogate"), which a JS string can validly hold and
  // JSONL faithfully stores. The seam's "lossless JSON data" invariant means
  // this backend must store whatever `materializeAppendBatch`/
  // `materializeCreateHeader` already validated, not re-validate it more
  // strictly than the seam requires.
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
}
