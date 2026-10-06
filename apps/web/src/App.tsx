import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Empty } from './components/ui'
import { CalibrationPage } from './pages/Calibration'
import { ComparePage } from './pages/Compare'
import { DatasetPage, DatasetsPage } from './pages/Datasets'
import { EvaluatorsPage } from './pages/Evaluators'
import { ExperimentsPage, NewExperimentPage } from './pages/Experiments'
import { OverviewPage } from './pages/Overview'
import { RunPage } from './pages/Run'
import { TargetPage, TargetsPage } from './pages/Targets'
import { TracesPage } from './pages/Traces'
import { TrialPage } from './pages/Trial'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="targets" element={<TargetsPage />} />
        <Route path="targets/:id" element={<TargetPage />} />
        <Route path="datasets" element={<DatasetsPage />} />
        <Route path="datasets/:id" element={<DatasetPage />} />
        <Route path="experiments" element={<ExperimentsPage />} />
        <Route path="experiments/new" element={<NewExperimentPage />} />
        <Route path="runs/:id" element={<RunPage />} />
        <Route path="trials/:id" element={<TrialPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="evaluators" element={<EvaluatorsPage />} />
        <Route path="calibration" element={<CalibrationPage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="*" element={<Empty title="Page not found">That address does not match a GaugeLab page.</Empty>} />
      </Route>
    </Routes>
  )
}
