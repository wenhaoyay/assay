import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { App } from './App'
import { CrumbsProvider } from './lib/crumbs'
import { PrefsProvider } from './lib/prefs'
import './index.css'

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
})

// A data router, so links and navigations can use view transitions.
const router = createBrowserRouter([{ path: '*', element: <App /> }])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <PrefsProvider>
        <CrumbsProvider>
          <RouterProvider router={router} />
        </CrumbsProvider>
      </PrefsProvider>
    </QueryClientProvider>
  </StrictMode>,
)
