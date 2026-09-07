import { NestFactory } from '@nestjs/core';
import { createLogger, PinoLoggerService } from '../common/logging/pino-logger.js';
import { loadEnv } from '../config/env.js';
import { WorkerModule } from './worker.module.js';

/**
 * XMS worker entrypoint (deployable `xms-worker`). A NestJS standalone
 * application that imports the same feature modules as the API so every
 * business rule exists once (ADR-08). It serves no HTTP except the health
 * endpoints; jobs claim work with SKIP LOCKED or SQS (Integration Patterns).
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'xms-worker');
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true, logger: new PinoLoggerService(logger) });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  logger.info({ port: env.PORT }, 'xms-worker listening');
}

await bootstrap();
