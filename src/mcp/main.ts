import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { HttpExceptionFilter } from '../common/http-exception.filter.js';
import { createLogger, httpLogger, PinoLoggerService } from '../common/logging/pino-logger.js';
import { requestContextMiddleware } from '../common/request-context.middleware.js';
import { trustProxyValue } from '../common/trust-proxy.js';
import { loadEnv } from '../config/env.js';
import { McpModule } from './mcp.module.js';

/**
 * XMS MCP entrypoint (deployable `xms-mcp`), the third alongside the API and
 * the worker (ADR-19).
 *
 * It serves one route, `POST /mcp`, to the harness on the caller's own token.
 * The pipeline in front of that route is the API's, deliberately: the same
 * whitelist validation, the same helmet headers, the same request context and
 * access log, the same exception filter wording a refusal. A second entrypoint
 * that set these up differently would be a second security posture to keep in
 * step, and the one that drifted would be this one, because it is the one
 * nobody looks at.
 *
 * No CORS: nothing in a browser calls this. No URI versioning: the protocol
 * carries its own version in the handshake.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'xms-mcp');
  const app = await NestFactory.create<NestExpressApplication>(McpModule, {
    bufferLogs: true,
    logger: new PinoLoggerService(logger),
  });

  if (env.TRUST_PROXY) {
    app.set('trust proxy', trustProxyValue(env.TRUST_PROXY));
  }

  app.use(helmet());
  app.use(requestContextMiddleware);
  app.use(httpLogger(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  logger.info({ port: env.PORT }, 'xms-mcp listening');
}

await bootstrap();
