import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';

/**
 * Emits openapi.json for the frontend's generated types (ADR-14: the frontend
 * consumes the backend only through this document). Run with `pnpm openapi`
 * after `pnpm build`; the pipeline publishes the file as a build artefact.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('XMS API').setVersion('0.1.0').addBearerAuth().build(),
  );
  writeFileSync('openapi.json', JSON.stringify(document, null, 2));
  await app.close();
}

await main();
