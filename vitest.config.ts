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
    // 子包与主包一起跑：check-test-integrity 用仓库级规则发现 **/*.test.ts，
    // include 漏掉 packages/** 会让 verify:test 直接红（见 adopt-superagent-openspec-source 任务 21）。
    include: ['src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
})
