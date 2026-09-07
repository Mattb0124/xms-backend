import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

/**
 * XMS API entrypoint (deployable `xms-api`).
 *
 * Global pipes and headers are set here once so no module can forget them:
 * whitelist validation rejects unknown fields (the AIX gap of decorators
 * without a pipe), helmet sets the security headers, versioning is URI-based
 * (`/v1/...`). The worker has its own entrypoint in worker/main.ts.
 */
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(helmet());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
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
}

await bootstrap();
