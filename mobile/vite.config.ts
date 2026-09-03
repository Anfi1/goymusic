import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Собираем десктопный UI (../src) как обычное веб-приложение: без electron-плагинов,
// с относительными путями (Capacitor грузит бандл из file:// внутри APK).
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    // ../src тянет react из своего дерева -- дедуплицируем, иначе два инстанса хуков.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@desktop': path.resolve(__dirname, '../src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
});
