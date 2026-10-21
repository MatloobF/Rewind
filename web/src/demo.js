// The read-only demo (npm run build:demo, published to GitHub Pages) has no
// server: it reads a snapshot of the API saved by scripts/export-demo.js.
// It's Vite's own build mode, so no environment variable is involved.
export const isDemo = import.meta.env.MODE === 'demo';

export const REPO_URL = 'https://github.com/MatloobF/Rewind';

// Where the demo keeps the saved response for an API path:
// /api/runs/<id>/tree -> <base>data/api/runs/<id>/tree.json
export const demoDataUrl = (path) => `${import.meta.env.BASE_URL}data${path}.json`;
