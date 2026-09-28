import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The repo-root .env is shared by the frontend, backend and docker-compose.
const envDir = '..';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  return {
    envDir,
    plugins: [react()],
    // MapLibre's worker is loaded as a module worker (see src/map/setupMapLibre.ts).
    worker: { format: 'es' },
    // MapLibre alone is ~1 MB minified (~300 kB gzipped); that's expected.
    build: { chunkSizeWarningLimit: 1500 },
    server: {
      port: 5173,
      // Proxy API calls in development so the browser talks to one origin.
      proxy: {
        '/api': env.VITE_API_URL || 'http://localhost:3001',
      },
    },
  };
});
