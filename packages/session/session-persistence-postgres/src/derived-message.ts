/**
 * Pure projection from one session event to a message-node row for the
 * `coffe_message` derived table, modeled on how a chat product (e.g.
 * ChatGPT's web export) stores conversation history: one row per turn with a
 * stable message id, its role, its complete structured content (not a
 * flattened text summary), and the lineage a caller needs to reconstruct
 * edit/regenerate history — here, the seq range a compaction rewrite
 * replaced (`replacesStartSeq`/`replacesEndSeq`) and the earlier seqs an
 * event cites as sources (`sourceEventSeqs`).
 *
 * Only the four conversational/tool-call event types produce a row
 * (`user/message`, `assistant/message`, `tool/call`, `tool/result`); every
 * other event type (turn/step boundaries, todo writes, request headers, …)
 * is structural, not a message, and `insertMessages` (`./index.ts`) skips it
 * entirely rather than writing a mostly-empty row. The complete event log,
 * including these structural events, stays authoritative in
 * `coffe_session_event`; this table is a queryable message log derived from
 * it, not a replacement for it.
 * @module @deepseek-ai/dsh-session-persistence-postgres/derived-message
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * One message-node row for `coffe_message`. Every optional field is
 * `null` when the source event carries no corresponding fact. String fields
 * are normalized for PostgreSQL; exact identifiers remain in the raw event.
 */
export interface DerivedMessageRow {
  /** Stable per-message id (`Message.id`); `null` for `tool/call`, which has no `Message` wrapper. */
  readonly messageId: string | null
  /**
   * A per-analysis role, not a verbatim copy of the wire-protocol
   * `Message.role`: `tool/call` and `tool/result` get their own roles
   * (`'tool_call'`/`'tool_result'`) so a query can tell a genuine user
   * message apart from a tool result the wire protocol also carries with
   * role `'user'`.
   */
  readonly role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  /** The event's complete structured content (content blocks, or a tool call's name/arguments), sanitized for `jsonb` storage. */
  readonly content: unknown
  /** Unix epoch milliseconds, copied from the event envelope. */
  readonly createTime: number
  /** The generating model; present only on `assistant/message`. */
  readonly model: string | null
  /** The generating provider; present only on `assistant/message`. */
  readonly provider: string | null
  /** The invoked tool's name; present only on `tool/call`. */
  readonly toolName: string | null
  /** Provider tool-call id correlating a `tool/call` with its `tool/result`. */
  readonly callId: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly reasoningTokens: number | null
  /** First replaced seq of a compaction rewrite this event performed, inclusive; `null` outside a `surfaceOp` replace. */
  readonly replacesStartSeq: number | null
  /** Last replaced seq of a compaction rewrite this event performed, inclusive; `null` outside a `surfaceOp` replace. */
  readonly replacesEndSeq: number | null
  /** Earlier seqs this event cites as sources; `null` when absent. */
  readonly sourceEventSeqs: readonly number[] | null
}

/** No event type outside `assistant/message` reports token accounting. */
const NO_USAGE = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
} as const

/** Neither `tool/call` (no surface participation) nor a plain `'append'` carries replace lineage. */
const NO_REPLACE = { replacesStartSeq: null, replacesEndSeq: null } as const

/**
 * Derive one event's message-node row.
 * @param event - the event as validated and about to be durably stored.
 * @returns the row, or `undefined` when the event is not one of the four
 *   conversational/tool-call types this table covers.
 */
export function deriveMessageRow(event: SessionEvent): DerivedMessageRow | undefined {
  switch (event.type) {
    case 'user/message':
      return {
        messageId: sanitizeText(event.data.id),
        role: 'user',
        content: sanitizeJsonValue(event.data.content),
        createTime: event.time,
        model: null,
        provider: null,
        toolName: null,
        callId: null,
        ...NO_USAGE,
        ...replaceLineage(event.surfaceOp),
        sourceEventSeqs: event.sourceEventSeqs ?? null,
      }
    case 'assistant/message': {
      const usage = event.data.usage
      return {
        messageId: sanitizeText(event.data.message.id),
        role: 'assistant',
        content: sanitizeJsonValue(event.data.message.content),
        createTime: event.time,
        model: sanitizeText(event.data.message.source.model),
        provider: sanitizeText(event.data.message.source.provider),
        toolName: null,
        callId: null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        ...replaceLineage(event.surfaceOp),
        // A v2 assistant/message embeds its provider stream instead of citing sources (see SurfaceIntent).
        sourceEventSeqs: null,
      }
    }
    case 'tool/call':
      return {
        messageId: null,
        role: 'tool_call',
        content: sanitizeJsonValue({ name: event.data.name, arguments: event.data.arguments }),
        createTime: event.time,
        model: null,
        provider: null,
        toolName: sanitizeText(event.data.name),
        callId: sanitizeText(event.data.callId),
        ...NO_USAGE,
        ...NO_REPLACE,
        sourceEventSeqs: null,
      }
    case 'tool/result':
      return {
        messageId: sanitizeText(event.data.message.id),
        role: 'tool_result',
        content: sanitizeJsonValue(event.data.message.content),
        createTime: event.time,
        model: null,
        provider: null,
        toolName: null,
        callId: sanitizeText(event.data.message.content[0].toolCallId),
        ...NO_USAGE,
        ...replaceLineage(event.surfaceOp),
        sourceEventSeqs: event.sourceEventSeqs ?? null,
      }
    // SessionEventMap is merge-extensible. Every other first-party and
    // plugin-declared event type is structural, not a message; the complete
    // event log already covers it in coffe_session_event.
    default:
      return undefined
  }
}

/** Extract compaction-rewrite lineage from one surface event's `surfaceOp`, when it replaced a seq range. */
function replaceLineage(surfaceOp: 'append' | { op: 'replace'; start: number; end: number } | undefined): Pick<DerivedMessageRow, 'replacesStartSeq' | 'replacesEndSeq'> {
  if (typeof surfaceOp !== 'object') return NO_REPLACE
  return { replacesStartSeq: surfaceOp.start, replacesEndSeq: surfaceOp.end }
}

/**
 * Replace NUL and lone UTF-16 surrogates in JSON keys and values. PostgreSQL
 * rejects these in jsonb; the sibling event bytea remains lossless.
 */
function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [sanitizeText(key), sanitizeJsonValue(entry)]))
  }
  return value
}

/**
 * Normalize one derived SQL string without altering its raw event.
 * @param value - a string from a validated event.
 * @returns PostgreSQL-compatible text with unsupported code units replaced by U+FFFD.
 */
export function sanitizeText(value: string): string {
  return value.toWellFormed().replaceAll('\0', '\ufffd')
}
