import { describe, expect, it } from 'vitest'
import { qualifiedTable, EVENT_TABLE, HEADER_TABLE } from '../src/schema.ts'

describe('qualifiedTable', () => {
  it('quotes the schema and table name', () => {
    expect(qualifiedTable('public', HEADER_TABLE)).toBe('"public"."dsh_session_header"')
    expect(qualifiedTable('public', EVENT_TABLE)).toBe('"public"."dsh_session_event"')
  })

  it('escapes an embedded double quote in the schema name', () => {
    expect(qualifiedTable('weird"schema', HEADER_TABLE)).toBe('"weird""schema"."dsh_session_header"')
  })
})
