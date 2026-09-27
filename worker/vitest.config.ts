import { defineConfig } from 'vitest/config'

// The worker is its own package: its own config, its own deps, and nothing
// imported from the app. The one thing outside this folder is `../shared/`, the
// SigV4 signer it deletes R2 objects with, so "copy this folder and `shared/`
// beside it, edit .env, run it" is what works on any machine.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
