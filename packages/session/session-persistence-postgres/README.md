---
description: "PostgreSQL session-persistence backend for deployments and maintainers choosing, configuring, or debugging a centralized, multi-instance-safe durable session store."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-postgres

## Summary

`dsh-session-persistence-postgres` stores every session's header and event log in two PostgreSQL tables instead of one file per session. It serves the same handle-based `SessionPersistence` API as the JSONL backend, so agent-loop persists and resumes sessions without knowing which backend is underneath. The reason to choose it over JSONL: cross-process single-writer exclusion comes from a Postgres advisory lock, not a kernel file lock, so multiple application instances sharing one database can safely host different sessions (or take turns owning the same one) without sharing a filesystem. Choose JSONL when a deployment is single-instance and wants one artifact per session on disk; choose this backend when sessions must be centrally queryable and the deployment already runs a shared Postgres.

Deliberately narrower than JSONL: it carries no historical format migration and writes only the current logical `SessionEvent` format (see [Known Limitations](#known-limitations-and-deferred-work)).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend instead of `dsh-session-persistence-jsonl` when sessions should live in a shared PostgreSQL database.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: postgres://user:password@host:5432/database
```

| Field | Default | Meaning |
|---|---|---|
| `connectionString` | required | Standard `postgres://user:password@host:port/database` connection string. No default: unlike a local file root, a database connection has no deployment-neutral fallback. |
| `schema` | `'public'` | Postgres schema holding the backend's two tables; created if absent. Use a distinct value per logical deployment sharing one database. |
| `ssl` | `false` | Whether to negotiate TLS with the server (required by most managed Postgres offerings). |
| `poolSize` | driver default | Maximum pooled connections. |

### Tables

Two tables under the configured schema: `dsh_session_header` (one row per session: id, header as raw JSON bytes, inherited-event-count, event count, revision) and `dsh_session_event` (one row per event, primary keyed `(session_id, seq)`, foreign-keyed to the header row with `ON DELETE CASCADE`). Nothing else reads or writes them; treat the schema as backend-owned.

`header`/`event` are `bytea`, not `jsonb`: Postgres's `jsonb` input parser refuses any text containing a NUL byte or a lone UTF-16 surrogate, which a JS string (and a real model response) can validly contain and JSONL faithfully stores. Storing raw UTF-8 bytes instead means this backend never re-validates more strictly than the seam's own `materializeCreateHeader`/`materializeAppendBatch` already did — see [Known Limitations](#known-limitations-and-deferred-work) for what this costs.

### Durability and crash semantics

A session materializes lazily, exactly like JSONL: `create()` returns an owned write handle immediately, and the header row appears on the session's first durable append or an explicit `flush()`. Every durable write (materializing insert, event insert, header revision bump) runs in one Postgres transaction, so a crash mid-write leaves either the complete prior state or the complete new state — there is no torn-tail repair path to run, because Postgres transactions do not leave partial commits for a reader to observe.

### Cross-process ownership

`open(id, 'write')` claims in-process ownership (this backend instance) and then takes a Postgres session-scoped advisory lock keyed by a hash of the session id (this connection). A concurrent write open — from this process or another instance sharing the database — rejects `SessionAlreadyOwnedError` the same way either way. The lock lives on a dedicated pooled connection for the handle's lifetime and releases on `close()`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The package mirrors the JSONL backend's runtime shape deliberately: `PostgresSessionHandle` carries the same per-handle mutation chain and bounded live-write batching window (`storage.ts`), and `PostgresBackendTracker` carries the same in-process bookkeeping (single writer per id, open-handle teardown sweep, pending-session visibility). The shared contract suites in `@deepseek-ai/dsh-session-persistence/tests` (`runPersistenceContract`, `runLiveWritePathContract`) pin the same observable behavior across both backends; only the physical storage (`schema.ts`, the query methods in `index.ts`) and the ownership mechanism (`lock.ts`) differ.

### Teardown ordering

Cordis disposes independent top-level effects concurrently (`Promise.all`), not in registration order. Ending the connection pool before every open handle has drained through it would silently lose the tail of a session's live-buffered events at shutdown, so the backend registers exactly one teardown effect that awaits `tracker.closeOpenHandles()` before calling `pool.end()`, instead of two effects racing each other.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `SessionPersistence` service, `Config`, and every SQL query |
| [`src/storage.ts`](src/storage.ts) | `PostgresSessionHandle` (mutation chain, live-write batching) and `PostgresBackendTracker` (ownership bookkeeping, teardown) |
| [`src/schema.ts`](src/schema.ts) | Table names and idempotent `CREATE TABLE IF NOT EXISTS` DDL |
| [`src/lock.ts`](src/lock.ts) | The session-scoped advisory lock |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

Identical to JSONL: this backend contributes no live prompt or schema. Loading restores stored surface history; the new loop composes its current envelope.

#### Token effect

Zero live-request tokens; a resumed agent pays for retained history and its current envelope.

#### KV Cache effect

This backend does not mutate live request prefixes; cache reuse depends only on the reconstructed history matching, same as JSONL.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No historical format migration** — this build writes and reads only the current `SessionEvent` format. A session log created before this backend existed (or by a different major format version) must stay on its original backend; there is no path to move it here. A deployment switching from JSONL starts fresh sessions on Postgres and leaves existing JSONL history where it is.
- **Nothing deletes session rows** — data accumulates in the two tables until removed externally; the seam has no deletion API.
- **Advisory-lock exclusion depends on a stable connection** — the lock lives on one pooled connection for the write handle's lifetime; a network partition that silently drops that connection without the client observing it could, in principle, let Postgres release the lock while this process still believes it holds it. `pool.on('error', ...)` surfaces a detected connection failure as a warning; it does not retry or fence the handle.
- **`readSlice`/`validateAndCountLog` re-query on every call** — unlike JSONL's cold-log memo, there is no in-process cache of a session's decoded event log; every read after a materialized open issues a fresh query. Acceptable for this backend's target use (centrally queryable sessions), revisit if a workload reads the same large session repeatedly.
- **One schema per logical deployment** — every session in a configured schema is visible to every backend instance pointed at it; multi-tenant isolation (a schema, or database, per tenant) is a deployment-time configuration choice this package does not enforce.
- **No server-side JSON querying** — `header`/`event` are `bytea`, so a session's content is opaque to SQL (no `->>`, no `jsonb` indexes); "centrally queryable" means one shared database instead of scattered files, not ad hoc `WHERE event->>'type' = …` filtering. A deployment that needs that would query through `session-query`-family tooling, not raw SQL against these tables.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
