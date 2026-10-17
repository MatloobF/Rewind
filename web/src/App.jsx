import { Link, NavLink, Route, Routes } from 'react-router';
import EvalList from './pages/EvalList.jsx';
import EvalPage from './pages/EvalPage.jsx';
import Failures from './pages/Failures.jsx';
import RunDiff from './pages/RunDiff.jsx';
import RunList from './pages/RunList.jsx';
import RunPage from './pages/RunPage.jsx';

const navClass = ({ isActive }) => (isActive ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-200');

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-baseline gap-6 px-6 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Rewind
          </Link>
          <nav className="flex gap-4 text-sm">
            <NavLink to="/" end className={navClass}>
              Runs
            </NavLink>
            <NavLink to="/failures" className={navClass}>
              Failures
            </NavLink>
            <NavLink to="/evals" className={navClass}>
              Evals
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">
        <Routes>
          <Route path="/" element={<RunList />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/runs/:id/diff" element={<RunDiff />} />
          <Route path="/failures" element={<Failures />} />
          <Route path="/evals" element={<EvalList />} />
          <Route path="/evals/:id" element={<EvalPage />} />
          <Route path="*" element={<p className="text-zinc-400">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
