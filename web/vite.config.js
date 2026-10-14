import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The browser only talks to Vite; Vite forwards /api to the Rewind
    // server. Same origin means the server needs no CORS setup.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
