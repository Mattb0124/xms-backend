import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { seedDev } from './seed.js';

/**
 * Development seed entrypoint (P1.3.7, P1.8.3):
 *
 *   pnpm seed:dev                 # 100 tickets per account (200 total)
 *   SEED_TICKETS=20 pnpm seed:dev # a smaller set
 *   pnpm dev:token --email admin@example.test
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const perAccount = Number(process.env.SEED_TICKETS ?? 100);
    await seedDev(app, { ticketsPerAccount: Number.isFinite(perAccount) ? perAccount : 100 });
  } finally {
    await app.close();
  }
}

await main();
