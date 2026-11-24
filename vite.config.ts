import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8731',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, source) => {
            if (source.headers.origin === 'http://127.0.0.1:5173') {
              request.setHeader('origin', 'http://127.0.0.1:8731');
            }
          });
        },
      },
    },
  },
});
