/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// GAUGELAB_API points the dev server at another API (a preview over a copy of the data).
const api = process.env.GAUGELAB_API ?? 'http://127.0.0.1:8040'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5240,
    proxy: {
      '/api': api,
      '/docs': api,
      '/openapi.json': api,
    },
  },
  build: { chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
