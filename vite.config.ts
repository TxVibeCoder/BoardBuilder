/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/boardbuilder/' : '/',
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
}));
