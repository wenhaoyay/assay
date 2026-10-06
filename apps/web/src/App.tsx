import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Empty } from './components/ui'
import { CalibrationPage } from './pages/Calibration'
import { ComparePage } from './pages/Compare'
import { ConnectPage } from './pages/Connect'
import { DatasetPage, DatasetsPage } from './pages/Datasets'
import { EvaluatorsPage } from './pages/Evaluators'
import { GatesPage } from './pages/Gates'
import { HomePage } from './pages/Home'
import { NewRunPage } from './pages/NewRun'
import { ProjectPage } from './pages/Project'
import { RunPage } from './pages/Run'
import { RunsPage } from './pages/Runs'
import { SettingsPage } from './pages/Settings'
import { TargetPage, TargetsPage } from './pages/Targets'
import { TrialPage } from './pages/Trial'

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
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
        <Route path="*" element={<Empty title="Page not found">That address does not match a GaugeLab page.</Empty>} />
      </Route>
    </Routes>
  )
}
