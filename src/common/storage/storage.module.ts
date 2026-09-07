import {
  Body,
  Controller,
  Get,
  Global,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolve } from 'node:path';
import { Public } from '../auth/public.decorator.js';
import { loadEnv } from '../../config/env.js';
import { FileTransport, SesTransport, type MailTransport } from '../mail/mail-transport.js';
import { LocalObjectStore, type ObjectStore } from './object-store.js';
import { S3ObjectStore } from './s3-object-store.js';

/**
 * Provides the object store and the mail transport from the environment
 * (production refuses anything but S3 and SES). In development the local
 * store's presigned URLs land on the two signed routes below; they are
 * public in the guard's sense because the signature is the credential,
 * exactly as an S3 presigned URL is.
 */
export const OBJECT_STORE = 'OBJECT_STORE';
export const MAIL_TRANSPORT = 'MAIL_TRANSPORT';

@Injectable()
export class StorageRoutesGuard {
  constructor(private readonly store: ObjectStore) {}

  get local(): LocalObjectStore | undefined {
    return this.store.kind === 'local' ? (this.store as LocalObjectStore) : undefined;
  }
}

@Controller('storage')
export class LocalStorageController {
  constructor(private readonly guard: StorageRoutesGuard) {}

  @Put('upload')
  @Public('local object store: the HMAC signature in the URL is the credential (development only)')
  async upload(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Query('contentType') contentType: string,
    @Query('maxBytes') maxBytes: string,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<{ ok: true; size: number }> {
    const local = this.guard.local;
    if (!local) throw new NotFoundException({ code: 'not_found' });
    if (!local.verify('upload', key, Number(expires), signature, `${contentType}\n${maxBytes}`))
      throw new UnauthorizedException({ code: 'bad_signature' });
    const raw = await readRawBody(request, body, Number(maxBytes));
    if (raw.length > Number(maxBytes)) throw new UnauthorizedException({ code: 'too_large' });
    const declared = request.header('content-type')?.split(';')[0]?.trim();
    if (declared && declared !== contentType) throw new UnauthorizedException({ code: 'content_type_mismatch' });
    await local.putObject(key, raw, contentType);
    return { ok: true, size: raw.length };
  }

  @Get('download')
  @Public('local object store: the HMAC signature in the URL is the credential (development only)')
  @Header('cache-control', 'no-store')
  async download(
    @Query('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Query('fileName') fileName: string,
    @Query('contentType') contentType: string,
    @Res() response: Response,
  ): Promise<void> {
    const local = this.guard.local;
    if (!local) throw new NotFoundException({ code: 'not_found' });
    if (!local.verify('download', key, Number(expires), signature))
      throw new UnauthorizedException({ code: 'bad_signature' });
    const body = await local.getObject(key).catch(() => undefined);
    if (!body) throw new NotFoundException({ code: 'not_found' });
    response.setHeader('content-type', contentType || 'application/octet-stream');
    response.setHeader('content-disposition', `attachment; filename="${(fileName || 'file').replace(/["\r\n]/g, '')}"`);
    response.send(body);
  }
}

/** Express parses JSON and form bodies only; every other content type is still on the stream. */
async function readRawBody(request: Request, parsed: unknown, maxBytes: number): Promise<Buffer> {
  if (Buffer.isBuffer(parsed)) return parsed;
  if (request.readable && !request.complete) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new UnauthorizedException({ code: 'too_large' });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  if (typeof parsed === 'string') return Buffer.from(parsed);
  return Buffer.from(JSON.stringify(parsed ?? ''));
}

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORE,
      useFactory: (): ObjectStore => {
        const env = loadEnv();
        if (env.STORAGE_KIND === 's3') return new S3ObjectStore(env.S3_BUCKET!, env.AWS_REGION);
        return new LocalObjectStore(resolve(env.STORAGE_LOCAL_ROOT), env.STORAGE_SIGNING_SECRET, env.API_BASE_URL);
      },
    },
    {
      provide: MAIL_TRANSPORT,
      useFactory: (store: ObjectStore): MailTransport => {
        const env = loadEnv();
        return env.MAIL_TRANSPORT === 'ses'
          ? new SesTransport(env.AWS_REGION, env.SES_CONFIGURATION_SET)
          : new FileTransport(store);
      },
      inject: [OBJECT_STORE],
    },
    {
      provide: StorageRoutesGuard,
      useFactory: (store: ObjectStore): StorageRoutesGuard => new StorageRoutesGuard(store),
      inject: [OBJECT_STORE],
    },
  ],
  exports: [OBJECT_STORE, MAIL_TRANSPORT, StorageRoutesGuard],
})
export class StorageCoreModule {}

/** The signed local-store routes; mounted by the API only. */
@Module({
  imports: [StorageCoreModule],
  controllers: [LocalStorageController],
  exports: [StorageCoreModule],
})
export class StorageModule {}
