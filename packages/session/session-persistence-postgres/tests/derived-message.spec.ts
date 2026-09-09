import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveMessageRow } from '../src/derived-message.ts'

const NO_USAGE = {
  inputTokens: null, outputTokens: null, totalTokens: null,
  cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
}
const NO_REPLACE = { replacesStartSeq: null, replacesEndSeq: null }

describe('deriveMessageRow', () => {
  it('projects a user message with its stable id, sanitized content, and cited sources', () => {
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: 'hello world' }],
      source: { kind: 'user' },
    })
    const event: SessionEvent<'user/message'> = {
      type: 'user/message',
      seq: SessionSeq(0),
      time: 10,
      data: userMessage,
      sourceEventSeqs: [SessionSeq(0)],
    }
    expect(deriveMessageRow(event)).toEqual({
      messageId: userMessage.id, role: 'user', content: [{ type: 'text', text: 'hello world' }],
      createTime: 10, model: null, provider: null, toolName: null, callId: null, ...NO_USAGE, ...NO_REPLACE,
      sourceEventSeqs: [0],
    })
  })

  it('sanitizes an embedded NUL byte in message content before jsonb storage', () => {
    const withNul = `hello${String.fromCharCode(0)}world`
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: withNul }],
      source: { kind: 'user' },
    })
    const event: SessionEvent<'user/message'> = {
      type: 'user/message', seq: SessionSeq(0), time: 10, data: userMessage,
    }
    const row = deriveMessageRow(event)
    expect(row?.content).toEqual([{ type: 'text', text: 'hello�world' }])
  })

  it('records a compaction rewrite\'s replaced seq range', () => {
    const userMessage = createUserMessage({ content: [], source: { kind: 'plugin', plugin: 'test' } })
    const event: SessionEvent<'user/message'> = {
      type: 'user/message', seq: SessionSeq(5), time: 11, data: userMessage,
      surfaceOp: { op: 'replace', start: SessionSeq(2), end: SessionSeq(4) },
    }
    expect(deriveMessageRow(event)).toMatchObject({ replacesStartSeq: 2, replacesEndSeq: 4 })
  })

  it('projects a metered assistant message with model, provider, and token usage', () => {
    const assistantMessage = createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock-model' } },
    })
    const event: SessionEvent<'assistant/message'> = {
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: 20,
      data: {
        turn: 1, step: 1, stream: [], message: assistantMessage,
        usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3 },
      },
    }
    expect(deriveMessageRow(event)).toEqual({
      messageId: assistantMessage.id, role: 'assistant', content: [{ type: 'text', text: 'reply' }],
      createTime: 20, model: 'mock-model', provider: 'mock', toolName: null, callId: null,
      inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3,
      ...NO_REPLACE, sourceEventSeqs: null,
    })
  })

  it('leaves token usage null for an unmetered assistant message', () => {
    const assistantMessage = createMessage({
      role: 'assistant', content: [], source: { kind: 'model', ...{ provider: 'mock', model: 'mock-model' } },
    })
    const event: SessionEvent<'assistant/message'> = {
      type: 'assistant/message', seq: SessionSeq(2), time: 21,
      data: { turn: 1, step: 1, stream: [], message: assistantMessage },
    }
    expect(deriveMessageRow(event)).toMatchObject(NO_USAGE)
  })

  it('projects a tool call as its name/arguments, with no message id', () => {
    const callId = ToolCallId('call-1')
    const event: SessionEvent<'tool/call'> = {
      type: 'tool/call', seq: SessionSeq(3), time: 30,
      data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{"cmd":"pwd"}' },
    }
    expect(deriveMessageRow(event)).toEqual({
      messageId: null, role: 'tool_call', content: { name: 'bash', arguments: '{"cmd":"pwd"}' },
      createTime: 30, model: null, provider: null, toolName: 'bash', callId, ...NO_USAGE, ...NO_REPLACE,
      sourceEventSeqs: null,
    })
  })

  it('projects a tool result under its own role, correlated by call id', () => {
    const callId = ToolCallId('call-1')
    const toolResultMessage = createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError: false })
    const event: SessionEvent<'tool/result'> = {
      type: 'tool/result', seq: SessionSeq(4), time: 31,
      data: { turn: 1, step: 1, message: toolResultMessage },
    }
    expect(deriveMessageRow(event)).toEqual({
      messageId: toolResultMessage.id, role: 'tool_result', content: toolResultMessage.content,
      createTime: 31, model: null, provider: null, toolName: null, callId, ...NO_USAGE, ...NO_REPLACE,
      sourceEventSeqs: null,
    })
  })

  it('produces no row for a structural event outside the message scope', () => {
    const event: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(6), time: 40, data: { turn: 1 } }
    expect(deriveMessageRow(event)).toBeUndefined()
  })
})
