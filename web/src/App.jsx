import { Link, Route, Routes } from 'react-router';
import RunList from './pages/RunList.jsx';
import RunPage from './pages/RunPage.jsx';

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Rewind
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<RunList />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="*" element={<p className="text-zinc-400">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
