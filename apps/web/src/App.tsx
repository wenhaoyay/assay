import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useOutletContext } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Empty, PageSkeleton } from './components/ui'

// Each page is its own chunk: the first screen loads without the charts and editors of the rest.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

const HomePage = page(() => import('./pages/Home'), 'HomePage')
const ProjectPage = page(() => import('./pages/Project'), 'ProjectPage')
const RunsPage = page(() => import('./pages/Runs'), 'RunsPage')
const NewRunPage = page(() => import('./pages/NewRun'), 'NewRunPage')
const RunPage = page(() => import('./pages/Run'), 'RunPage')
const TrialPage = page(() => import('./pages/Trial'), 'TrialPage')
const ComparePage = page(() => import('./pages/Compare'), 'ComparePage')
const TargetsPage = page(() => import('./pages/Targets'), 'TargetsPage')
const TargetPage = page(() => import('./pages/Targets'), 'TargetPage')
const ConnectPage = page(() => import('./pages/Connect'), 'ConnectPage')
const DatasetsPage = page(() => import('./pages/Datasets'), 'DatasetsPage')
const DatasetPage = page(() => import('./pages/Datasets'), 'DatasetPage')
const GatesPage = page(() => import('./pages/Gates'), 'GatesPage')
const CalibrationPage = page(() => import('./pages/Calibration'), 'CalibrationPage')
const EvaluatorsPage = page(() => import('./pages/Evaluators'), 'EvaluatorsPage')
const SettingsPage = page(() => import('./pages/Settings'), 'SettingsPage')

/** Suspense around the pages, passing the layout's context (start the tour...) through. */
function Pages() {
  const ctx = useOutletContext()
  return <Suspense fallback={<PageSkeleton />}><Outlet context={ctx} /></Suspense>
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route element={<Pages />}>
          <Route index element={<HomePage />} />
          <Route path="p/:id" element={<ProjectPage />} />
          <Route path="runs" element={<RunsPage />} />
          <Route path="runs/new" element={<NewRunPage />} />
          <Route path="runs/:id" element={<RunPage />} />
          <Route path="trials/:id" element={<TrialPage />} />
          <Route path="compare" element={<ComparePage />} />
          <Route path="targets" element={<TargetsPage />} />
          <Route path="targets/new" element={<ConnectPage />} />
          <Route path="targets/:id" element={<TargetPage />} />
          <Route path="datasets" element={<DatasetsPage />} />
          <Route path="datasets/:id" element={<DatasetPage />} />
          <Route path="gates" element={<GatesPage />} />
          <Route path="calibration" element={<CalibrationPage />} />
          <Route path="evaluators" element={<EvaluatorsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Old addresses keep working. */}
          <Route path="experiments" element={<Navigate to="/runs" replace />} />
          <Route path="experiments/new" element={<Navigate to="/runs/new" replace />} />
          <Route path="traces" element={<Navigate to="/runs" replace />} />
          <Route path="*" element={<Empty title="Page not found">That address does not match an Assay page.</Empty>} />
        </Route>
      </Route>
    </Routes>
  )
}
