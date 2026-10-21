import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './index.css';

// One cache for the whole app. React Query refetches when the window
// regains focus, so a run recorded in the terminal shows up on return.
const queryClient = new QueryClient();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* The demo is served from /Rewind/ on GitHub Pages; dev and Docker from /. */}
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
