import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = 'http://localhost:3002';
// xfwd: sunucu isteğin gerçek kaynağını (bu bilgisayar mı, telefon mu) görsün;
// yerel ağ erişim kapısı buna göre karar verir.
const proxy = { target: SERVER, xfwd: true };

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': proxy,
      '/auth': proxy,
      '/clips': proxy,
      '/socket.io': { ...proxy, ws: true },
    },
  },
});
