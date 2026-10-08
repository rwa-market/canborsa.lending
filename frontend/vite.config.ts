/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/** Short git hash for the build label in the footer: a stale dist is visible at once (F-17). */
function buildId(): string {
  try {
    const rev = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return `${rev}${dirty ? '+dirty' : ''}`
  } catch {
    return 'unknown'
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(env.VITE_BUILD_ID || buildId()),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      // The backend listens on 3001 (backend/.env); the frontend reaches it via /api.
      // BACKEND_URL: another backend, e.g. a second instance on 3002
      proxy: {
        '/api': {
          target: process.env.BACKEND_URL ?? 'http://127.0.0.1:3001',
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  }
})
