import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [preact(), tailwindcss()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/admin': {
        target: 'http://127.0.0.1:19090',
        changeOrigin: false,
      },
    },
  },
})
