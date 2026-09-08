import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { requestContextMiddleware } from './common/request-context.middleware.js';
import { createLogger, httpLogger, PinoLoggerService } from './common/logging/pino-logger.js';
import { trustProxyValue } from './common/trust-proxy.js';
import { loadEnv } from './config/env.js';

/**
 * XMS API entrypoint (deployable `xms-api`).
 *
 * Global pipes and headers are set here once so no module can forget them:
 * whitelist validation rejects unknown fields (the AIX gap of decorators
 * without a pipe), helmet sets the security headers, versioning is URI-based
 * (`/v1/...`). The worker has its own entrypoint in worker/main.ts.
 */
/** The largest request body any route accepts; the demand import is the largest of them. */
export const BODY_LIMIT = '1mb';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env, 'xms-api');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    logger: new PinoLoggerService(logger),
  });

  // Behind an ALB every request otherwise reports the balancer's address,
  // so one caller's burst rate-limits everyone and ip_hash is a constant on
  // every security event. Configured, never assumed: trusting an unset hop
  // count in front of nothing would let a caller spoof X-Forwarded-For.
  if (env.TRUST_PROXY) {
    app.set('trust proxy', trustProxyValue(env.TRUST_PROXY));
  }

  // Stated rather than inherited: without this the effective cap is
  // Express's implicit 100 kB, which silently contradicts the 900 kB demand
  // import DTO. One documented number, and the routes that need more say so.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });

  app.use(helmet());
  app.use(requestContextMiddleware);
  app.use(httpLogger(logger));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('XMS API')
      .setDescription(
        'Xelerated Managed Services API. Every route declares its permission; portal and internal realms never cross.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  if (env.NODE_ENV !== 'production') {
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(env.PORT);
  logger.info({ port: env.PORT }, 'xms-api listening');
}

await bootstrap();
