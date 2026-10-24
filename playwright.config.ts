import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      DATABASE_PATH: join(tmpdir(), `flightguard-e2e-${process.pid}.sqlite`),
      PORT: '4174',
      VITE_API_TARGET: 'http://127.0.0.1:4174',
      LLM_ENABLED: 'false',
      WEATHER_MODEL_ENABLED: 'false',
    },
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], ...(process.env.PLAYWRIGHT_CHANNEL === 'msedge' ? { channel: 'msedge' as const } : {}) },
  }],
});
