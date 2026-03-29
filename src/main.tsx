import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

// Initialize react-scan ONLY in development and ONLY if requested
// Using dynamic import to ensure it's completely excluded from production build
if (import.meta.env.DEV && typeof window !== 'undefined') {
  import('react-scan').then(({ scan }) => {
    scan({
      enabled: true,
      log: false,
    });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60, // Aggressive: 60 seconds - free up memory almost immediately
      refetchOnWindowFocus: false,
      refetchOnMount: false, // Don't refetch when switching views if data is still fresh
      retry: 1
    }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
)
