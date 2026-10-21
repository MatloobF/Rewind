import { copyFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// GitHub Pages answers an unknown path (/Rewind/runs/<id>) with 404.html, so
// a copy of index.html lets a reloaded or shared link still load the app.
const pagesFallback = {
  name: 'pages-404-fallback',
  apply: 'build',
  closeBundle() {
    copyFileSync('dist/index.html', 'dist/404.html');
  },
};

// `vite build --mode demo` (npm run build:demo) builds the read-only demo for
// GitHub Pages: served from /Rewind/, with the API snapshot in demo/ copied in
// (see src/demo.js and scripts/export-demo.js).
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'demo' ? [pagesFallback] : [])],
  base: mode === 'demo' ? '/Rewind/' : '/',
  publicDir: mode === 'demo' ? 'demo' : 'public',
  server: {
    port: 5173,
    // The browser only talks to Vite; Vite forwards /api to the Rewind
    // server and /intel to the Python intel service. Same origin means
    // neither needs CORS setup.
    proxy: {
      '/api': 'http://localhost:4000',
      '/intel': {
        target: 'http://localhost:8000',
        rewrite: (path) => path.replace(/^\/intel/, ''),
      },
    },
  },
}));
