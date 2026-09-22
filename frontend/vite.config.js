import { defineConfig } from 'vite';

export default defineConfig({
  envDir: '..',
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/questions.json': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
