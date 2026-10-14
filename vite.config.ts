import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = 'http://localhost:3002';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': SERVER,
      '/auth': SERVER,
      '/clips': SERVER,
      '/socket.io': { target: SERVER, ws: true },
    },
  },
});
