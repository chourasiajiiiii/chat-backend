import { defineConfig } from 'vitest/config';

// Set here (not in .env) so the tests never point at the dev database by accident.
// Workers inherit these from this process.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/chat_app_test';
process.env.FIREBASE_PROJECT_ID = 'demo-chat-backend';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    // all files share one database
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
