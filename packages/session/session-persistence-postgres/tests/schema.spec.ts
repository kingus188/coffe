import { describe, expect, it } from 'vitest'
import { qualifiedTable, EVENT_TABLE, HEADER_TABLE, MESSAGE_TABLE } from '../src/schema.ts'

describe('qualifiedTable', () => {
  it('quotes the schema and table name', () => {
    expect(qualifiedTable('public', HEADER_TABLE)).toBe('"public"."coffe_session"')
    expect(qualifiedTable('public', EVENT_TABLE)).toBe('"public"."coffe_session_event"')
    expect(qualifiedTable('public', MESSAGE_TABLE)).toBe('"public"."coffe_message"')
  })

  it('escapes an embedded double quote in the schema name', () => {
    expect(qualifiedTable('weird"schema', HEADER_TABLE)).toBe('"weird""schema"."coffe_session"')
  })
})
