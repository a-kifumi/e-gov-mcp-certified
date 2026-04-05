import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.OPENROUTER_PRIMARY_MODEL': JSON.stringify(
        env.OPENROUTER_PRIMARY_MODEL || 'qwen/qwen3.6-plus:free',
      ),
      'process.env.OPENROUTER_FALLBACK_MODELS': JSON.stringify(
        env.OPENROUTER_FALLBACK_MODELS || 'stepfun/step-3.5-flash:free',
      ),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
