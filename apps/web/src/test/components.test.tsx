import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AgreementPanel } from '../pages/Calibration'
import { MetricTable, direction, reading } from '../pages/Compare'
import { VersionBadge } from '../pages/Datasets'
import { validateSetup } from '../pages/Experiments'
import { RunPage } from '../pages/Run'
import type { CalibrationStats, ComparisonRow } from '../lib/types'

function wrap(ui: ReactNode, path = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('dataset version badge', () => {
  it('shows the version, frozen status and how many runs froze it', () => {
    wrap(<VersionBadge v={{ version: 3, status: 'frozen', run_count: 2 }} />)
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.getByText('Frozen')).toBeInTheDocument()
    expect(screen.getByText(/used by 2 runs/)).toBeInTheDocument()
  })
  it('a draft says nothing about runs', () => {
    wrap(<VersionBadge v={{ version: 4, status: 'draft', run_count: 0 }} />)
    expect(screen.getByText('Draft')).toBeInTheDocument()
    expect(screen.queryByText(/used by/)).not.toBeInTheDocument()
  })
})

describe('experiment setup validation', () => {
  const judges = ['correctness', 'groundedness']
  it('requires a target, a dataset version and evaluators', () => {
    const errs = validateSetup({ targetVersionId: '', datasetVersionId: '', evaluators: [], judge: '' }, judges)
    expect(errs).toHaveLength(3)
  })
  it('requires a judge when judge evaluators are selected', () => {
    const errs = validateSetup({ targetVersionId: 1, datasetVersionId: 2, evaluators: ['must_mention', 'correctness'], judge: '' }, judges)
    expect(errs).toEqual(['Judge evaluators selected (correctness) but no judge chosen.'])
    expect(validateSetup({ targetVersionId: 1, datasetVersionId: 2, evaluators: ['correctness'], judge: 'heuristic' }, judges)).toEqual([])
  })
})

const rate = (over: Partial<ComparisonRow>): ComparisonRow => ({
  metric: 'overall_pass_rate', label: 'Overall pass rate', unit: 'rate', baseline: 0.5, candidate: 0.7, delta: 0.2,
  relative: 0.4, ci: { delta: 0.2, ci_low: 0.1, ci_high: 0.3, n: 58, excludes_zero: true }, ...over,
})

describe('comparison metrics', () => {
  it('never calls an interval that includes zero anything but noise', () => {
    expect(reading(rate({})).text).toBe('likely better')
    expect(reading(rate({ ci: { delta: 0.02, ci_low: -0.05, ci_high: 0.09, n: 58, excludes_zero: false } })).text).toBe('within noise')
    expect(reading(rate({ delta: -0.2, candidate: 0.3, ci: { delta: -0.2, ci_low: -0.3, ci_high: -0.1, n: 58, excludes_zero: true } })).text).toBe('likely worse')
  })
  it('lower is better for latency and cost', () => {
    expect(direction(rate({ unit: 'latency', delta: 300 }))).toBe('worse')
    expect(direction(rate({ unit: 'cost', delta: -0.001 }))).toBe('better')
  })
  it('renders values, delta in percentage points, the interval with n, and the reading', () => {
    wrap(<MetricTable rows={[rate({}), rate({ metric: 'p95_latency_ms', label: 'p95 latency', unit: 'latency', baseline: 2000, candidate: 2400, delta: 400, relative: 0.2, ci: null })]} />)
    const row = screen.getByTestId('metric-overall_pass_rate')
    expect(within(row).getByText('50.0%')).toBeInTheDocument()
    expect(within(row).getByText('+20.0pp')).toBeInTheDocument()
    expect(within(row).getByText('10.0 to 30.0pp (n=58)')).toBeInTheDocument()
    const lat = screen.getByTestId('metric-p95_latency_ms')
    expect(within(lat).getByText('+20.0%')).toBeInTheDocument()
    expect(within(lat).getByLabelText('worse')).toBeInTheDocument()
  })
})

describe('calibration metrics', () => {
  const stats: CalibrationStats = {
    dimension: 'correctness', status: 'Calibrated on 20 samples', small_sample: true, judges: [], disagreements: [],
    agreement: {
      n: 20, accuracy: 0.75, precision: 7 / 9, recall: 0.7, f1: 0.7368, kappa: 0.5, positive: 'FAIL',
      confusion: { PASS: { PASS: 8, FAIL: 2, UNKNOWN: 0 }, FAIL: { PASS: 3, FAIL: 7, UNKNOWN: 0 }, UNKNOWN: { PASS: 0, FAIL: 0, UNKNOWN: 0 } },
    },
  }
  it('shows sample size, accuracy, kappa and the confusion matrix', () => {
    wrap(<AgreementPanel s={stats} />)
    expect(screen.getByText('Calibrated on 20 samples')).toBeInTheDocument()
    expect(screen.getByText(/small sample/)).toBeInTheDocument()
    expect(screen.getByText('75.0%')).toBeInTheDocument()
    expect(screen.getByText('0.50')).toBeInTheDocument()
    expect(screen.getByTestId('cell-FAIL-FAIL')).toHaveTextContent('7')
    expect(screen.getByTestId('cell-PASS-FAIL')).toHaveTextContent('2')
  })
  it('an unlabelled judge is shown as uncalibrated', () => {
    wrap(<AgreementPanel s={{ ...stats, agreement: { ...stats.agreement, n: 0 } }} />)
    expect(screen.getByText('Uncalibrated')).toBeInTheDocument()
  })
})

describe('failure filtering', () => {
  const run = {
    id: 7, experiment: 'exp', status: 'completed', source: 'live', target: 't', target_version: 1, variant_label: '', dataset: 'd',
    dataset_version: 1, trials_per_case: 1, judge: null, progress_done: 2, progress_total: 2, metrics: {}, gate_results: [], snapshot: {},
    n_cases: 2, failed_trials: 2, error: null, stop_reason: null, parent_run_id: null,
    summary: { failed_trials: 2, failures: { retrieval_miss: 1, wrong_answer: 1 }, metrics: {}, evaluators: {}, reliability: {}, by_category: {}, overall: { value: 0, ci_low: null, ci_high: null, n: 2 }, telemetry: {}, trials_per_case: 1 },
  }
  const trial = (id: number, ft: string) => ({ id, run_id: 7, case_id: `case_${ft}`, trial_index: 0, status: 'failed', answer: 'a', failure_types: [ft], failed_evaluators: [ft === 'retrieval_miss' ? 'recall_at_k' : 'exact_match'], failure_override: false, tags: [], question: `q ${ft}` })
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url, 'http://x')
      let body: unknown = run
      if (u.pathname.endsWith('/trials')) {
        const ft = u.searchParams.get('failure_type')
        body = [trial(1, 'retrieval_miss'), trial(2, 'wrong_answer')].filter((t) => !ft || t.failure_types.includes(ft))
      }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists failure types and filters the trials by the clicked type', async () => {
    wrap(<Routes><Route path="/runs/:id" element={<RunPage />} /></Routes>, '/runs/7?tab=failures')
    expect(await screen.findByText('case_retrieval_miss')).toBeInTheDocument()
    expect(screen.getByText('case_wrong_answer')).toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Retrieval miss' })[0])
    expect(await screen.findByText('Clear filter')).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.queryByText('case_wrong_answer')).not.toBeInTheDocument())
    expect(screen.getByText('case_retrieval_miss')).toBeInTheDocument()
  })
})
