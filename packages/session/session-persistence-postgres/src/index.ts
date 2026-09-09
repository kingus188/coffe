/**
 * PostgreSQL durable session-persistence backend. It stores a header and
 * contiguous events across two tables (see `./schema.ts`) and serves the
 * handle-based `SessionPersistence` API: `create`/`open` return per-session
 * handles, and every read validates the same fail-closed storage contract
 * shared with the JSONL backend. Unlike JSONL, this backend supports
 * multiple application instances sharing one database: cross-process
 * single-writer exclusion comes from a Postgres advisory lock (`./lock.ts`),
 * not a kernel file lock.
 *
 * Deliberately narrower than the JSONL backend: it carries no historical
 * format migration and writes only the current logical `SessionEvent`
 * format. A deployment migrating off JSONL keeps its existing on-disk
 * history there (unaffected) and starts fresh sessions on this backend; see
 * `## Known Limitations and Deferred Work` in the package README.
 * @module @deepseek-ai/dsh-session-persistence-postgres
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Default import: pg ships CJS without statically analyzable named exports,
// so `import { Pool } from 'pg'` is unreliable under Node's ESM/CJS interop.
import pg from 'pg'
import type { Pool as PoolType, PoolClient } from 'pg'
const { Pool } = pg
import {
  SessionPersistence, SessionPersistenceRevision, SessionAlreadyExistsError,
  SessionAlreadyOwnedError, SessionPersistenceNotFoundError,
  assertStoredId, assertVersion, materializeCreateHeader, validateStoredEvents,
  type SessionAccess, type SessionHandle,
  type SessionHandleReadResult,
  type SessionLocation, type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot, type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import { PostgresBackendTracker, PostgresSessionHandle } from './storage.ts'
import type { PostgresHandleStorage } from './storage.ts'
import { tryAcquireAdvisoryLock, type AdvisoryLock } from './lock.ts'
import { ensureSchema, qualifiedTable, EVENT_TABLE, HEADER_TABLE } from './schema.ts'

/** Plugin config for the Postgres backend's connection and target schema. */
export interface Config {
  /**
   * Standard `postgres://user:password@host:port/database` connection
   * string. Required (no default): unlike a local file root, a database
   * connection has no deployment-neutral default to fall back to.
   */
  connectionString: string
  /** Postgres schema holding the backend's tables; created if absent. */
  schema?: string
  /** Whether to negotiate TLS with the server (required by most managed Postgres). */
  ssl?: boolean
  /** Maximum pooled connections; omit to use the driver's own default. */
  poolSize?: number
}

/**
 * Row shapes for `pg`'s generic `query<R extends QueryResultRow>`, which
 * requires an index signature; each pairs its known columns with `unknown`
 * for that signature. `header`/`event` columns are `bytea`, so `pg` returns
 * them as `Buffer`; {@link decodeJson} parses them at each use site rather
 * than trusting the bytes, since a stored row crosses a durable-storage
 * boundary.
 */
interface EventRow {
  readonly event: unknown
  readonly [column: string]: unknown
}

/** One row from a header-table listing query. */
interface HeaderListRow {
  readonly id: string
  readonly header: unknown
  readonly event_count: string
  readonly revision: string
  readonly [column: string]: unknown
}

/** One row from a single-session header lookup. */
interface HeaderRow {
  readonly header: unknown
  readonly inherited_event_count: string
  readonly event_count: string
  readonly revision: string
  readonly [column: string]: unknown
}

/**
 * Encode a validated, losslessly-JSON-serializable value as UTF-8 bytes for a
 * `bytea` parameter. Plain `JSON.stringify` — not `jsonb`'s stricter input
 * parser — is the only validation this value needs; it already passed
 * {@link materializeCreateHeader}/{@link materializeAppendBatch}.
 */
function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

/** Decode one `bytea` column back into its stored JSON value; the caller casts it. */
function decodeJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString('utf8'))
}

/** Deep-freeze one acyclic stored JSON event without recursive calls. */
function freezeStoredEvent(event: SessionEvent): void {
  const pending: object[] = [event]
  while (pending.length > 0) {
    // The non-empty check proves an object remains to visit.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const current = pending.pop()!
    Object.freeze(current)
    for (const key in current) {
      const child = (current as Record<string, unknown>)[key]
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
}

/**
 * The Postgres persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence`. Sessions materialize lazily: a created session is
 * visible to this process immediately, reaches the database on its first
 * append or flush, and never existed if the process crashes before that.
 */
class PostgresSessionPersistence extends SessionPersistence implements PostgresHandleStorage {
  static Config: z<Config> = z.object({
    connectionString: z.string().required(),
    schema: z.string().default('public'),
    ssl: z.boolean().default(false),
    poolSize: z.number(),
  })

  /** Backend label for diagnostics and effects; shadows `Service.name` without changing the service key. */
  override readonly name = 'session-persistence-postgres'

  private readonly pool: PoolType
  private readonly schemaName: string
  private readonly headerTable: string
  private readonly eventTable: string
  private readonly tracker = new PostgresBackendTracker(this.name)
  private ready: Promise<void> | undefined

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.schemaName = config.schema ?? 'public'
    this.headerTable = qualifiedTable(this.schemaName, HEADER_TABLE)
    this.eventTable = qualifiedTable(this.schemaName, EVENT_TABLE)
    this.pool = new Pool({
      connectionString: config.connectionString,
      ssl: config.ssl,
      ...config.poolSize === undefined ? {} : { max: config.poolSize },
    })
    // node-postgres emits 'error' on the pool when an idle client's backend
    // connection breaks (network blip, server restart); without a listener
    // Node treats that as an uncaught exception and can crash the process.
    this.pool.on('error', (error: Error) => {
      ctx.logger.warn(`${this.name}: idle pooled connection failed: ${String(error)}`)
    })
    this.tracker.install(ctx)
    // One effect, not two: Cordis disposes independent top-level effects
    // concurrently, not in registration order, so draining every open
    // handle must be sequenced explicitly BEFORE the pool ends — a second,
    // separate effect for the pool would race the drain instead of waiting
    // for it.
    ctx.effect(() => async () => {
      await this.tracker.closeOpenHandles()
      await this.pool.end()
    }, this.name)
  }

  private ensureReady(): Promise<void> {
    return this.ready ??= ensureSchema(this.pool, this.schemaName)
  }

  /** Refusal-diagnostics hook: a query locator, not a filesystem path (there is no artifact file to open). */
  private locate(id: SessionId): SessionLocation {
    return { kind: 'postgres', path: `${this.eventTable} (session_id=${id})` }
  }

  // --- SessionPersistence service API ---

  /**
   * Create a new stored session and take its write ownership. The session is
   * visible to this process immediately; the durable row appears on the
   * first append or flush.
   * @param header - the immutable header to store; must be losslessly
   *   JSON-serializable with a non-negative safe-integer `createdAt`.
   * @param options - optional cancellation.
   * @returns the owned write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    const inheritedEventCount = SessionLogOffset(options?.inheritedEventCount ?? 0)
    await this.ensureReady()
    options?.signal?.throwIfAborted()
    if (this.tracker.hasPending(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    const result = await this.pool.query(`SELECT 1 FROM ${this.headerTable} WHERE id = $1`, [snapshot.id])
    options?.signal?.throwIfAborted()
    if (result.rowCount !== null && result.rowCount > 0) throw new SessionAlreadyExistsError(snapshot.id)
    this.tracker.registerCreated(snapshot, inheritedEventCount)
    return this.tracker.adopt(new PostgresSessionHandle(
      this, snapshot.id, snapshot, 'write',
      { cursor: 0, materialized: false, inheritedEventCount },
    ))
  }

  /**
   * Open an existing stored session for `read` or single-writer `write`.
   * @param id - the stored session to open.
   * @param access - `read` (no ownership) or `write` (atomic in-process claim
   *   plus a cross-process advisory lock).
   * @param options - optional cancellation.
   * @returns the open handle.
   */
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    await this.ensureReady()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (access === 'read') {
      if (pending !== undefined) {
        return this.tracker.adopt(new PostgresSessionHandle(
          this, id, pending.header, 'read',
          { cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount },
        ))
      }
      const row = await this.fetchHeaderRow(id)
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      return this.tracker.adopt(new PostgresSessionHandle(
        this, id, row.header, 'read',
        { cursor: row.eventCount, materialized: true, inheritedEventCount: row.inheritedEventCount },
      ))
    }
    // A pending entry always belongs to an ACTIVE creator handle (close
    // erases it), so the claim below rejects that case as already owned.
    this.tracker.claimWrite(id)
    let lock: AdvisoryLock | undefined
    try {
      const row = await this.fetchHeaderRow(id)
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      options?.signal?.throwIfAborted()
      lock = await this.acquireWriteLock(row.header)
      const count = await this.validateAndCountLog(row.header, options?.signal)
      options?.signal?.throwIfAborted()
      return this.tracker.adopt(new PostgresSessionHandle(
        this, id, row.header, 'write',
        { cursor: count, materialized: true, inheritedEventCount: row.inheritedEventCount },
        lock,
      ))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      let releaseFailure: Error | undefined
      try {
        await lock?.release()
      } catch (raw: unknown) {
        releaseFailure = raw instanceof Error ? raw : new Error(String(raw))
      }
      this.tracker.releaseClaim(id)
      if (releaseFailure !== undefined) {
        throw new AggregateError([failure, releaseFailure], `session "${id}": write open failed and its lock release failed`)
      }
      throw failure
    }
  }

  /**
   * Flush every active write handle in one durability barrier; see the seam
   * contract.
   * @returns resolution once every write handle active at the call has flushed.
   */
  flush(): Promise<void> {
    return this.tracker.flushAll()
  }

  /**
   * Observe one stored session without reading its event log.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    await this.ensureReady()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) return { header: pending.header, revision: pending.revision }
    const row = await this.fetchHeaderRow(id)
    if (row === undefined) return undefined
    return { header: row.header, revision: row.revision, eventCount: row.eventCount }
  }

  /**
   * List every stored session visible to this process: durable rows plus
   * this process's created-but-unmaterialized sessions.
   * @param options - optional cancellation.
   * @returns one snapshot per session, in no promised order.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    options?.signal?.throwIfAborted()
    await this.ensureReady()
    options?.signal?.throwIfAborted()
    // Snapshot pending entries BEFORE querying storage: a session whose first
    // append lands mid-scan is then still in this snapshot (its row may
    // predate the scan), so create-to-list visibility never has a hole.
    const pendingEntries = [...this.tracker.pendingEntries()]
    const result = await this.pool.query<HeaderListRow>(
      `SELECT id, header, event_count, revision FROM ${this.headerTable}`,
    )
    options?.signal?.throwIfAborted()
    const listed = new Set<SessionId>()
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const row of result.rows) {
      // A stored header column round-trips exactly the JSON this backend
      // wrote; TypeScript's Session-id/log-offset brands are erased at
      // runtime, so the parsed value already carries the right shape.
      const header = decodeJson(row.header as Buffer) as SessionHeader
      assertVersion(header, this.locate(header.id))
      listed.add(header.id)
      snapshots.push({
        header,
        revision: SessionPersistenceRevision(row.revision),
        eventCount: Number(row.event_count),
      })
    }
    for (const [id, entry] of pendingEntries) {
      if (!listed.has(id)) snapshots.push({ header: entry.header, revision: entry.revision })
    }
    return snapshots
  }

  // --- PostgresHandleStorage (handle-facing storage internals) ---

  /**
   * Durably append one validated batch, or materialize the header row plus
   * its first batch when `isMaterialized` is false; one transaction covers
   * both the row insert (when materializing) and the event insert, so a
   * partial failure leaves neither behind.
   */
  async persistBatch(
    header: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
    inheritedEventCount: SessionLogOffsetType,
  ): Promise<void> {
    await this.ensureReady()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (!isMaterialized) {
        const insert = await client.query(
          `INSERT INTO ${this.headerTable} (id, header, inherited_event_count) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
          [header.id, encodeJson(header), inheritedEventCount],
        )
        // Another process's concurrent materialize won the race for this id.
        if (insert.rowCount === 0) throw new SessionAlreadyExistsError(header.id)
      }
      if (events.length > 0) await this.insertEvents(client, header.id, events)
      await client.query(
        `UPDATE ${this.headerTable} SET revision = revision + 1, event_count = event_count + $2 WHERE id = $1`,
        [header.id, events.length],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    if (!isMaterialized) this.tracker.materialized(header.id)
  }

  /**
   * Materialize a header-only row for an explicitly flushed empty session.
   * @param header - the session's stored header.
   * @param inheritedEventCount - the exact fork-inherited prefix length.
   */
  async persistHeader(header: SessionHeader, inheritedEventCount: SessionLogOffsetType): Promise<void> {
    await this.ensureReady()
    const insert = await this.pool.query(
      `INSERT INTO ${this.headerTable} (id, header, inherited_event_count) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [header.id, encodeJson(header), inheritedEventCount],
    )
    if (insert.rowCount === 0) throw new SessionAlreadyExistsError(header.id)
    this.tracker.materialized(header.id)
  }

  /**
   * Read, fail-closed validate, and freeze one slice of the durable log.
   * @param header - the session's stored header.
   * @param offset - first logical seq to include.
   * @param length - maximum events to return.
   * @param signal - optional cancellation.
   */
  async readSlice(header: SessionHeader, offset: number, length: number, signal?: AbortSignal): Promise<SessionHandleReadResult> {
    signal?.throwIfAborted()
    const result = await this.pool.query<EventRow>(
      `SELECT event FROM ${this.eventTable} WHERE session_id = $1 ORDER BY seq OFFSET $2 LIMIT $3`,
      [header.id, offset, length],
    )
    signal?.throwIfAborted()
    const events = result.rows.map(row => decodeJson(row.event as Buffer) as SessionEvent)
    validateStoredEvents(header, events, this.locate(header.id))
    for (const event of events) freezeStoredEvent(event)
    Object.freeze(events)
    return { eventState: 'shared-frozen', events }
  }

  /**
   * Load the complete durable log and fail-closed validate every event, so a
   * write open refuses immediately rather than on a later read.
   * @param header - the session's stored header.
   * @param signal - optional cancellation.
   * @returns the validated event count (the write cursor).
   */
  async validateAndCountLog(header: SessionHeader, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted()
    const result = await this.pool.query<EventRow>(
      `SELECT event FROM ${this.eventTable} WHERE session_id = $1 ORDER BY seq`,
      [header.id],
    )
    signal?.throwIfAborted()
    const events = result.rows.map(row => decodeJson(row.event as Buffer) as SessionEvent)
    validateStoredEvents(header, events, this.locate(header.id))
    return events.length
  }

  /**
   * Whether this process still tracks a created-but-unmaterialized session.
   * @param id - the session to test.
   * @returns true while the pending entry exists.
   */
  hasPendingSession(id: SessionId): boolean {
    return this.tracker.hasPending(id)
  }

  /**
   * Take the session-scoped advisory lock guarding this session across every
   * application instance sharing the database.
   * @param header - the session's stored header.
   * @returns the held lock.
   * @throws {SessionAlreadyOwnedError} when another connection (this process
   *   or another instance) already holds it.
   */
  async acquireWriteLock(header: SessionHeader): Promise<AdvisoryLock> {
    const lock = await tryAcquireAdvisoryLock(this.pool, header.id)
    if (lock === undefined) throw new SessionAlreadyOwnedError(header.id)
    return lock
  }

  /**
   * Release one handle's backend bookkeeping on close.
   * @param handle - the closing handle.
   * @param materialized - whether the session reached durable storage.
   */
  releaseHandle(handle: PostgresSessionHandle, materialized: boolean): void {
    this.tracker.release(handle, materialized)
  }

  // --- query helpers ---

  private async fetchHeaderRow(id: SessionId): Promise<{
    header: SessionHeader
    inheritedEventCount: SessionLogOffsetType
    eventCount: number
    revision: SessionPersistenceRevision
  } | undefined> {
    const result = await this.pool.query<HeaderRow>(
      `SELECT header, inherited_event_count, event_count, revision FROM ${this.headerTable} WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined
    // See the comment in list(): the stored header round-trips verbatim.
    const header = decodeJson(row.header as Buffer) as SessionHeader
    assertStoredId(id, header)
    assertVersion(header, this.locate(id))
    return {
      header,
      inheritedEventCount: SessionLogOffset(Number(row.inherited_event_count)),
      eventCount: Number(row.event_count),
      revision: SessionPersistenceRevision(row.revision),
    }
  }

  private async insertEvents(client: PoolClient, id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const placeholders: string[] = []
    const params: unknown[] = [id]
    for (const event of events) {
      placeholders.push(`($1, $${params.length + 1}, $${params.length + 2})`)
      params.push(event.seq, encodeJson(event))
    }
    await client.query(
      `INSERT INTO ${this.eventTable} (session_id, seq, event) VALUES ${placeholders.join(', ')}`,
      params,
    )
  }
}

export default PostgresSessionPersistence
