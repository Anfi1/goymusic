import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Собираем десктопный UI (../src) как обычное веб-приложение: без electron-плагинов,
// с относительными путями (Capacitor грузит бандл из file:// внутри APK).
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    // ../src лежит вне mobile/, поэтому его импорты резолвятся в КОРНЕВОЙ
    // node_modules, а точка входа -- в mobile/node_modules. Без дедупликации в бандл
    // попадают две копии: у react это два набора хуков, у react-query -- два разных
    // контекста, и приложение падает с "No QueryClient set".
    dedupe: [
      'react', 'react-dom', '@tanstack/react-query',
      'react-virtuoso', 'lucide-react', 'twemoji',
    ],
    alias: {
      '@desktop': path.resolve(__dirname, '../src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // В WebView Capacitor'а modulepreload по схеме https://localhost падает
    // ("Unable to preload CSS"), а разбитый по чанкам CSS до страницы не доезжает.
    // Собираем стили одним файлом из index.html и preload не используем.
    cssCodeSplit: false,
    modulePreload: false,
  },
});
