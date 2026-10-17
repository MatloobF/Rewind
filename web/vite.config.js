import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
});
