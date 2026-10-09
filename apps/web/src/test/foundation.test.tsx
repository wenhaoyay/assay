import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Checkbox, Chip, Menu, MenuItem } from '../components/form'
import { causeColor, RATE_FAIL, RATE_PASS, rateBand, rateColor } from '../components/instrument'
import { Badge, Dialog, Empty, SectionHead, StatusBadge, stateOf, Textarea } from '../components/ui'
import { fmtDate, fmtDay, ms, NA, pct, pp, seconds, when } from '../lib/format'

describe('rate bands', () => {
  it('snaps to pass / flaky / fail at the band edges', () => {
    expect(rateBand(1)).toBe('pass')
    expect(rateBand(RATE_PASS)).toBe('pass')
    expect(rateBand(RATE_PASS - 0.001)).toBe('flaky')
    expect(rateBand(RATE_FAIL)).toBe('flaky')
    expect(rateBand(RATE_FAIL - 0.001)).toBe('fail')
    expect(rateBand(0)).toBe('fail')
  })
  it('has no band without a rate', () => {
    for (const v of [null, undefined, NaN]) expect(rateBand(v)).toBe('none')
    expect(rateColor(null)).toBe('var(--untested)')
  })
  it('returns a state token, never a blend', () => {
    expect(rateColor(0.95)).toBe('var(--good)')
    expect(rateColor(0.6)).toBe('var(--flaky)')
    expect(rateColor(0.2)).toBe('var(--bad)')
  })
  it('gives each cause a token and the not-the-bot causes different ones', () => {
    const three = ['off_topic', 'test_suspect', 'cant_tell'].map(causeColor)
    expect(new Set(three).size).toBe(3)
    expect(causeColor('made_up')).toBe('var(--cause-made-up)')
  })
})

describe('formatting', () => {
  it('writes points with a unicode minus, one decimal and a spaced unit', () => {
    expect(pp(0.236)).toBe('+23.6 pp')
    expect(pp(-0.02)).toBe('−2.0 pp')
    expect(pp(0)).toBe('0.0 pp')
    expect(pp(-0.00001)).toBe('0.0 pp')
    expect(pp(NaN)).toBe(NA)
    expect(pp(null)).toBe(NA)
  })
  it('spaces time units and guards NaN', () => {
    expect(ms(340)).toBe('340 ms')
    expect(ms(1234)).toBe('1.2 s')
    expect(ms(-120, true)).toBe('−120 ms')
    expect(ms(120, true)).toBe('+120 ms')
    expect(ms(NaN)).toBe(NA)
    expect(seconds(1.24)).toBe('1.2 s')
    expect(seconds(undefined)).toBe(NA)
    expect(pct(NaN)).toBe(NA)
  })
  it('writes every date in one locale (day month year, 24 hour clock)', () => {
    const iso = '2026-10-09T14:05:00'
    expect(fmtDay(iso)).toBe('9 Oct 2026')
    expect(fmtDate(iso)).toBe('9 Oct 2026, 14:05')
    expect(when(iso)).toBe('9 Oct, 14:05')
    expect(fmtDay('nonsense')).toBe(NA)
    expect(when(null)).toBe(NA)
  })
})

describe('states', () => {
  it('writes statuses in sentence case', () => {
    render(<><StatusBadge status="PASS" /><StatusBadge status="INCOMPLETE" /><StatusBadge status="UNKNOWN" /></>)
    for (const t of ['Pass', 'Incomplete', 'Unknown']) expect(screen.getByText(t)).toBeInTheDocument()
  })
  it('maps status words to one of the states', () => {
    expect(stateOf('passed')).toBe('pass')
    expect(stateOf('FAIL')).toBe('fail')
    expect(stateOf('whatever')).toBe('unscored')
  })
  it('gives a failed run and a failed gate the same style', () => {
    render(<><StatusBadge status="failed" /><StatusBadge status="FAIL" /></>)
    expect(screen.getByText('Failed').className).toBe(screen.getByText('Fail').className)
  })
  it('hatches heuristic scores', () => {
    render(<Badge tone="heuristic">word overlap</Badge>)
    expect(screen.getByText('word overlap')).toHaveClass('hatched')
  })
})

describe('shared components', () => {
  it('Empty drops a trailing full stop from the title', () => {
    render(<Empty title="No datasets yet.">Add one.</Empty>)
    expect(screen.getByText('No datasets yet')).toBeInTheDocument()
  })
  it('SectionHead keeps the title whole and renders actions', () => {
    render(<SectionHead title="By category" meta="n=58" actions={<button type="button">Export</button>} />)
    expect(screen.getByRole('heading', { name: 'By category' })).not.toHaveClass('truncate')
    expect(screen.getByText('n=58')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })
  it('Textarea is sans unless mono', () => {
    render(<><Textarea aria-label="a" /><Textarea mono aria-label="b" /></>)
    expect(screen.getByLabelText('a')).not.toHaveClass('font-mono')
    expect(screen.getByLabelText('b')).toHaveClass('font-mono')
  })
  it('Chip and Checkbox report their state', async () => {
    const user = userEvent.setup()
    function Demo() {
      const [on, setOn] = useState(false)
      return <><Chip selected={on} onClick={() => setOn(!on)}>Failed</Chip><Checkbox checked={on} onChange={setOn} label="Only failed" /></>
    }
    render(<Demo />)
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Failed' }))
    expect(screen.getByRole('button', { name: 'Failed' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('checkbox', { name: 'Only failed' })).toBeChecked()
  })
  it('Menu opens, closes on a pick and on Escape', async () => {
    const user = userEvent.setup()
    render(<Menu trigger={({ props }) => <button type="button" {...props}>Share</button>}><MenuItem>Copy link</MenuItem></Menu>)
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})

describe('Dialog', () => {
  function Demo() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Delete it">
          <button type="button">First</button>
          <button type="button">Last</button>
        </Dialog>
      </>
    )
  }
  it('is labelled by its title, moves focus in, traps Tab, closes on Escape and returns focus', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const opener = screen.getByRole('button', { name: 'Open' })
    await user.click(opener)
    const dlg = screen.getByRole('dialog', { name: 'Delete it' })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })
})
