import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../components/Golden'
import { findChatId, quotedLiterals } from '../pages/Connect'
import { plainPattern } from '../lib/trials'

describe('plain-word rules', () => {
  it('turns words into patterns that do what they say', () => {
    const anyOf = plainPattern('any', ['EOL', 'end of life'])
    expect(anyOf).toBe('(?i)(EOL|end of life)')
    const num = plainPattern('number', ['91'])
    // Python syntax; check the JS equivalent behaves (no inline flag needed for digits).
    const rx = new RegExp(num)
    expect(rx.test('factory calendar 91')).toBe(true)
    expect(rx.test('calendar 910')).toBe(false)
    expect(rx.test('version 1.91')).toBe(false)
    expect(plainPattern('word', ['a.b'])).toBe(String.raw`(?i)\ba\.b\b`)
  })
})

describe('connect wizard helpers', () => {
  it('spots "null" written as text', () => {
    expect(quotedLiterals({ question: '{{input.message}}', conversation_id: 'null', opts: { stream: 'true' } }))
      .toEqual([{ path: 'body.conversation_id', value: 'null' }, { path: 'body.opts.stream', value: 'true' }])
    expect(quotedLiterals({ conversation_id: null })).toEqual([])
  })

  it('finds the chat id where a streamed reply has it', () => {
    expect(findChatId({ answer: 'x', done: { ms: 12, conversation_id: 'a1b2' } })).toBe('done.conversation_id')
    expect(findChatId({ session_id: 'eval-1' })).toBe('session_id')
    expect(findChatId({ answer: 'no id' })).toBeNull()
  })
})

describe('prompt kit', () => {
  it('names the bot, the documents, the mix and the import columns', () => {
    const p = buildPrompt({ bot: 'PP Assistant', domain: 'SAP production planning', docs: ['Blueprint v28.pdf'], n: 20,
      mix: { lookup: 8, multi_source: 4, specific: 3, refusal: 3, confusable: 2 } })
    expect(p).toContain('"PP Assistant"')
    expect(p).toContain('- Blueprint v28.pdf')
    expect(p).toContain('8 x lookup')
    expect(p).toContain('Question,Must mention (comma-separated),Must never say,Should refuse? (yes/no)')
    expect(p).toMatch(/Use ONLY the attached documents/)
  })
})
