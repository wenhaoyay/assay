import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../components/Golden'
import { findChatId, quotedLiterals } from '../pages/Connect'
import { describePattern, plainPattern } from '../lib/trials'
import { flow } from '../components/run/Sankey'
import type { ExploreTrial } from '../lib/types'

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
    const p = buildPrompt({ bot: 'Sample Support Bot', domain: 'sample product support', docs: ['Demo Handbook'], n: 20,
      mix: { lookup: 8, multi_source: 4, specific: 3, refusal: 3, confusable: 2 } })
    expect(p).toContain('"Sample Support Bot"')
    expect(p).toContain('- Demo Handbook')
    expect(p).toContain('8 x lookup')
    expect(p).toContain('Question,Must mention (comma-separated),Must never say,Should refuse? (yes/no)')
    expect(p).toMatch(/Use ONLY the attached documents/)
  })
})

describe('patterns in plain words', () => {
  it('reads back the plain-word rules, and leaves real patterns as they are', () => {
    expect(describePattern(plainPattern('any', ['EOL', 'end of life']))).toBe('any of "EOL", "end of life"')
    expect(describePattern(plainPattern('word', ['AX42']))).toBe('the word "AX42"')
    expect(describePattern(plainPattern('number', ['91']))).toBe('the number 91')
    expect(describePattern('(?i)SSSC')).toBe('"SSSC"')
    expect(describePattern('(?i)(which|what)\s+(site|office)')).toBeNull()
  })
})

describe('where the answers went', () => {
  const trial = (scores: Record<string, { status: string }>, kind: Partial<ExploreTrial>) =>
    ({ status: 'passed', scores, should_refuse: false, needs_tool: false, needs_documents: false, ...kind }) as unknown as ExploreTrial
  const targets = (ts: ExploreTrial[]) => {
    const { nodes, links } = flow(ts)
    return links.map((l) => nodes[l.target].name)
  }
  it('never shows a check that was not measured as a success', () => {
    expect(targets([trial({}, { needs_documents: true })])).toContain('Not measured')
    expect(targets([trial({ recall_at_k: { status: 'not_evaluated' } }, { needs_documents: true })])).not.toContain('Search found it')
    expect(targets([trial({}, { needs_tool: true })])).not.toContain('Right tool')
    expect(targets([trial({ recall_at_k: { status: 'pass' } }, { needs_documents: true })])).toContain('Search found it')
  })
})
