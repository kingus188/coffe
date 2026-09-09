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

Three tables under the configured schema. `dsh_session_header` (one row per session: id, header as raw JSON bytes, inherited-event-count, event count, revision) and `dsh_session_event` (one row per event, primary keyed `(session_id, seq)`, foreign-keyed to the header row with `ON DELETE CASCADE`, plus two generic envelope columns — `type`, `event_time` — for querying the complete log by event type or time range) are the durable seam storage. `dsh_session_message` is a derived per-message projection; see below. Nothing else reads or writes any of them; treat the schema as backend-owned.

`header`/`event` are `bytea`, not `jsonb`: Postgres's `jsonb` input parser refuses any text containing a NUL byte or a lone UTF-16 surrogate, which a JS string (and a real model response) can validly contain and JSONL faithfully stores. Storing raw UTF-8 bytes instead means this backend never re-validates more strictly than the seam's own `materializeCreateHeader`/`materializeAppendBatch` already did — see [Known Limitations](#known-limitations-and-deferred-work) for what this costs.

### `dsh_session_message`: a queryable per-message table

Modeled on how a chat product (e.g. ChatGPT's web export) stores conversation history — one row per turn, with a stable id, its role, and its complete structured content — rather than an opaque log an operator must decode to analyze. `insertMessages` (`src/index.ts`) writes one row per conversational/tool-call event, in the *same transaction* as the raw `event` bytes, so this table is always exactly as durable and as current as the source it derives from (no separate reconciliation pass). Only four event types produce a row — `user/message`, `assistant/message`, `tool/call`, `tool/result` — because every other event type (turn/step boundaries, todo writes, request headers, …) is structural, not a message; the complete log, including those, stays in `dsh_session_event`.

| Column | Meaning |
|---|---|
| `session_id`, `seq` | Primary key; `seq` anchors the row to its source event in `dsh_session_event`. |
| `message_id` | The stable `Message.id` this event carries; `null` for `tool/call`, which has no `Message` wrapper. |
| `role` | `'user'`, `'assistant'`, `'tool_call'`, or `'tool_result'` — a per-analysis role, not a verbatim copy of the wire-protocol `Message.role` (a tool result's wire role is `'user'`; this column gives it its own value instead, so a query can tell it apart from a genuine user message). |
| `content` | The event's complete structured content as `jsonb` — content blocks (text, image/file references, nested tool-result blocks) for `user/message`/`assistant/message`/`tool/result`, or `{name, arguments}` for `tool/call` — sanitized (`\0` → `�`) before insertion, since `jsonb` rejects an embedded NUL byte outright; the sibling `dsh_session_event.event` stays the untouched, lossless source. |
| `content_tsv` | Generated `tsvector` (GIN-indexed) over every string leaf in `content`, via `jsonb_to_tsvector`; supports full-text SQL search without a separate flattened text column. |
| `create_time` | Unix epoch milliseconds, copied from the event envelope. |
| `model`, `provider` | The generating model/provider; present only on `assistant/message`. |
| `tool_name`, `call_id` | The invoked tool's name (on `tool/call`) and the id correlating a `tool/call` with its `tool/result`. |
| `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | Metered token accounting; present only on a metered `assistant/message`. |
| `replaces_start_seq`, `replaces_end_seq` | The seq range a compaction rewrite replaced (from the event's `surfaceOp`), when this row is that replacement — the "edited/regenerated" lineage a caller needs to reconstruct branch history, ChatGPT's node-tree parent link in spirit. |
| `source_event_seqs` | Earlier seqs this event cites as sources, when present. |

Every optional column is `NULL` when its event carries no corresponding fact. Example queries:

```sql
-- Tool calls with their result text, joined by call id
SELECT c.session_id, c.tool_name, r.content AS result
FROM dsh_session_message c
JOIN dsh_session_message r ON r.session_id = c.session_id AND r.call_id = c.call_id AND r.role = 'tool_result'
WHERE c.role = 'tool_call';

-- Token spend per session
SELECT session_id, sum(output_tokens) FROM dsh_session_message GROUP BY session_id;

-- Full-text search over message content
SELECT session_id, seq, content FROM dsh_session_message
WHERE content_tsv @@ to_tsquery('simple', 'deploy');
```

`content_tsv` uses Postgres's `simple` text-search configuration (tokenizes on whitespace/punctuation, no stemming or dictionary), which does not word-segment CJK text meaningfully; a deployment needing that installs a CJK-aware search extension (e.g. `zhparser`) itself, or uses `content ->> ...`/`pg_trgm` for substring search over specific fields. A schema created by an earlier version of this backend gains `dsh_session_message` and the event table's envelope columns automatically the next time any instance starts (`ensureSchema`); rows appended before that upgrade have no corresponding message row — there is no backfill pass that replays pre-existing `dsh_session_event` rows into it.

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
| [`src/schema.ts`](src/schema.ts) | Table names and idempotent `CREATE TABLE IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` DDL |
| [`src/lock.ts`](src/lock.ts) | The session-scoped advisory lock |
| [`src/derived-message.ts`](src/derived-message.ts) | Pure projection from one `SessionEvent` to the `dsh_session_message` row `insertMessages` writes |
| — | No runtime invariant companion is published; cross-process advisory-lock ownership and the durable-write transaction boundary are validated by the shared contract suites against a real Postgres instance, not an in-process observation this package could diverge on independently. |

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

Identical to JSONL: this backend contributes no live prompt or schema. Loading restores stored surface history by decoding each `dsh_session_event.event` row back into its `SessionEvent`; the new loop composes its current envelope from that reconstruction.

#### Token effect

Zero live-request tokens; a resumed agent pays for retained history and its current envelope.

#### KV Cache effect

This backend does not mutate live request prefixes; cache reuse depends only on the reconstructed history matching, same as JSONL.

## Known Limitations and Deferred Work

These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No historical format migration** — this build writes and reads only the current `SessionEvent` format. A session log created before this backend existed (or by a different major format version) must stay on its original backend; there is no path to move it here. A deployment switching from JSONL starts fresh sessions on Postgres and leaves existing JSONL history where it is.
- **Nothing deletes session rows** — data accumulates in the two tables until removed externally; the seam has no deletion API.
- **Advisory-lock exclusion depends on a stable connection** — the lock lives on one pooled connection for the write handle's lifetime; a network partition that silently drops that connection without the client observing it could, in principle, let Postgres release the lock while this process still believes it holds it. `pool.on('error', ...)` surfaces a detected connection failure as a warning; it does not retry or fence the handle.
- **`readSlice`/`validateAndCountLog` re-query on every call** — unlike JSONL's cold-log memo, there is no in-process cache of a session's decoded event log; every read after a materialized open issues a fresh query. Acceptable for this backend's target use (centrally queryable sessions), revisit if a workload reads the same large session repeatedly.
- **One schema per logical deployment** — every session in a configured schema is visible to every backend instance pointed at it; multi-tenant isolation (a schema, or database, per tenant) is a deployment-time configuration choice this package does not enforce.
- **No arbitrary server-side JSON querying** — `header`/`event` stay `bytea`, so a session's complete content has no `->>`/`jsonb`-index path; only [`dsh_session_message`](#dsh_session_message-a-queryable-per-message-table) (role, structured content, tool identity, token usage, full-text content, compaction lineage) is directly queryable. A deployment needing structured access to a payload field that table does not cover reads and decodes `event` itself, or queries through `session-query`-family tooling.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
