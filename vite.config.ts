import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    // Scoped to the app. The worker is a separate package with its own config
    // and runs in node, not jsdom; without this it gets swept in here and
    // passes under the wrong environment by luck.
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
