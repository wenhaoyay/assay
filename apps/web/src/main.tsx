import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/instrument-serif/400.css'
import '@fontsource/instrument-serif/400-italic.css'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { App } from './App'
import { toast } from './components/ui'
import { CrumbsProvider } from './lib/crumbs'
import { PrefsProvider } from './lib/prefs'
import './index.css'

const client = new QueryClient({
  // A failed action says so, unless the screen shows its own error (meta: { silent: true }).
  mutationCache: new MutationCache({
    onError: (error, _v, _c, mutation) => {
      if (mutation.meta?.silent) return
      toast(error instanceof Error ? error.message : 'Something went wrong', 'bad')
    },
  }),
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
