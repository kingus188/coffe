/**
 * Cross-process single-writer exclusion via a Postgres session-scoped
 * advisory lock, keyed by session id. Unlike the JSONL backend's kernel file
 * lock, this is the mechanism that makes single-writer-per-session hold
 * across multiple application instances sharing one database — the reason to
 * choose this backend over a local file.
 * @module @deepseek-ai/dsh-session-persistence-postgres/lock
 */

import type { Pool, PoolClient } from 'pg'

/** One held advisory lock; release it when the write handle closes. */
export interface AdvisoryLock {
  /** Release the lock and return the dedicated connection to the pool. */
  release(): Promise<void>
}

/**
 * Attempt to take the session-scoped advisory lock for one session id. The
 * lock lives on a dedicated connection checked out of the pool for the
 * lock's lifetime — Postgres advisory locks are tied to the physical session
 * that took them, not to a logical transaction.
 * @param pool - the connection pool to check a dedicated client out of.
 * @param sessionId - the session identity the lock guards.
 * @returns the held lock, or `undefined` when another connection holds it.
 */
export async function tryAcquireAdvisoryLock(pool: Pool, sessionId: string): Promise<AdvisoryLock | undefined> {
  const client: PoolClient = await pool.connect()
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [sessionId],
    )
    if (result.rows[0]?.locked !== true) {
      client.release()
      return undefined
    }
  } catch (error) {
    client.release(error instanceof Error ? error : new Error(String(error)))
    throw error
  }
  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [sessionId])
      } finally {
        client.release()
      }
    },
  }
}
