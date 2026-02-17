import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5053,
    proxy: {
      '/api': 'http://localhost:5054',
    },
  },
})
