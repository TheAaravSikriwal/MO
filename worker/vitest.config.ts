import { defineConfig } from 'vitest/config'

// The worker is a standalone package: its own config, its own deps, no import
// of anything from the app. That is what makes "copy the folder, edit .env,
// run it" true on any machine.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
