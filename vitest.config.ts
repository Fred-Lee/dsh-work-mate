import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const local = (name: string): string => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url))

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // ui-primitives resolves through the profile's symlink; keep a single React
    // instance so hooks in shared atoms run against the same dispatcher.
    alias: {
      react: local('react'),
      'react/jsx-runtime': local('react/jsx-runtime'),
      'react-dom': local('react-dom'),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
})
