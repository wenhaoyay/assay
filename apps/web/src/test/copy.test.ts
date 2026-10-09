// Copy lint: the words docs/design.md ("Words") bans, in every string a person can read.
// It reads the source (not the rendered page), so a banned word fails the build before it ships.
// Server sentences have the same lint in tests/test_copy.py.
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Every source file under src (as text), found by the bundler, so this test needs no file-system types.
const SOURCES = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!../test/**', '!../**/*.d.ts'], { query: '?raw', import: 'default', eager: true })
// The glossary is where "judge" is explained.
const SKIP_FILES = new Set(['../lib/glossary.ts'])

/** Words and marks that must not reach the screen. */
const BANNED: [RegExp, string][] = [
  [/\(s\)/, 'a "(s)" plural: use plural() from lib/format'],
  [/\.\.\./, '"..." (write "…")'],
  [/—/, 'an em dash'],
  [/\b(trials?|evaluators?|experiments?|targets?|judges?)\b/i, 'an old name (see docs/design.md, Words)'],
  [/\bthis (PC|machine)\b/i, '"this PC" / "this machine" (say "this computer")'],
]

/** Sentences that may use a banned word (one place only). */
const ALLOWED: RegExp[] = [
  /also called a judge/, // Settings > Models & keys: the one place a grading model is called a judge
]

/** Attributes whose value a person reads. Every other attribute (className, data-*, to, href, key...) is code. */
const READ_ATTRS = new Set(['aria-label', 'title', 'placeholder', 'label', 'alt', 'helpTitle', 'aria-valuetext', 'description'])

/** Is this text code (a route, a path, an id), not a sentence? */
function isCode(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/^\.{1,2}\//.test(t) || /^[/?#]/.test(t) || t.includes('://') || t.includes('/api/')) return true
  if (!/\s/.test(t) && t === t.toLowerCase()) return true // a bare lowercase token: an id or a key
  return false
}

interface Hit { file: string; line: number; text: string; why: string }

function scan([path, text]: [string, string]): Hit[] {
  const rel = path.replace(/^\.\.\//, '')
  if (SKIP_FILES.has(path)) return []
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: Hit[] = []
  const check = (node: ts.Node, text: string) => {
    if (isCode(text) || ALLOWED.some((a) => a.test(text))) return
    for (const [pattern, why] of BANNED) {
      if (pattern.test(text)) {
        hits.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: text.trim().slice(0, 80), why })
        return
      }
    }
  }
  const visit = (node: ts.Node): void => {
    // Imports and exports name modules; object keys and property names are identifiers.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) return
    if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))) { visit(node.initializer); return }
    if (ts.isLiteralTypeNode(node) || ts.isEnumMember(node)) return
    if (ts.isElementAccessExpression(node)) { visit(node.expression); return }
    if (ts.isCaseClause(node)) { node.statements.forEach(visit); return }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      // a comparison against a status or an id ("x === 'trial'") is code
      visit(node.left)
      return
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText()
      const init = node.initializer
      if (init && READ_ATTRS.has(name)) visit(init)
      else if (init && ts.isJsxExpression(init) && init.expression && !/^(className|data-|to$|href|key|id$|type|role|value|name|style)/.test(name)) visit(init.expression)
      return
    }
    if (ts.isJsxText(node)) check(node, node.text)
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text)
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) check(node, node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('copy', () => {
  const all = Object.entries(SOURCES).flatMap(scan)
  it('keeps the banned words and marks out of everything a person reads', () => {
    const report = all.map((h) => `${h.file}:${h.line}  ${h.why}: ${JSON.stringify(h.text)}`)
    expect(report).toEqual([])
  })
  it('reads the source files it should', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(40)
  })
})
