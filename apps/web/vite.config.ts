import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 前缀匹配，避免正则不命中时请求落到 Vite 静态资源 → 404
      '/daily-reports': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/meta': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/analytics': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/export': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
