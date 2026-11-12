import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Capacitor 打包用相对路径，避免绝对 /assets 在 WebView 中 404
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true },
    },
  },
})
