import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  CurrentPrincipal,
  RealmOf,
  RequestCtx,
  RequirePermission,
  type RequestContext,
} from '../../common/auth/decorators.js';
import { actorOf, AuditService } from '../../common/audit/audit.service.js';
import type { Principal } from '../../common/auth/principal.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { ImageNotDecodableError, isReEncodedImage, reEncodeImage } from '../../common/images/reencode.js';
import { OBJECT_STORE } from '../../common/storage/storage.module.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';
import { TicketsCoreModule } from '../tickets/tickets.module.js';
import { TicketsRepository, ticketKey } from '../tickets/tickets.repository.js';

/**
 * Attachments (Ticket Management technical 2.4, 3.3; Security section 6;
 * P1.6.1): presigned upload with a size range and a content type
 * condition, a MIME and extension allowlist, rows created `pending`, the
 * scan result consumer (GuardDuty in AWS, the local scanner in
 * development) moving quarantined objects and notifying, downloads only for
 * `clean`, portal reads of public attachments only.
 */
export const ALLOWED_TYPES: Record<string, readonly string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'csv'],
  'text/csv': ['csv'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/vnd.ms-excel': ['xls'],
  'application/msword': ['doc'],
  'message/rfc822': ['eml'],
};

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export interface AttachmentRow {
  id: string;
  account_id: string;
  ticket_id: string;
  comment_id: string | null;
  work_note_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: string;
  s3_key: string;
  scan_state: 'pending' | 'clean' | 'quarantined';
  scan_detail: Record<string, unknown> | null;
  origin: string;
  visibility: 'public' | 'internal';
  uploaded_by: string;
  uploaded_by_name: string;
  /** What the image re-encode did, when the file arrived as bytes (Security section 6). */
  re_encode: Record<string, unknown> | null;
  created_at: string;
  deleted_at: string | null;
}

@Injectable()
export class AttachmentsRepository extends RepositoryBase {
  byId(tx: Tx, id: string): Promise<AttachmentRow> {
    return this.one<AttachmentRow>(
      tx,
      'attachment',
      'select * from acct.attachments where id = $1 and deleted_at is null',
      [id],
    );
  }

  ofTicket(tx: Tx, ticketId: string, publicOnly = false): Promise<AttachmentRow[]> {
    return this.many<AttachmentRow>(
      tx,
      `select * from acct.attachments where ticket_id = $1 and deleted_at is null ${publicOnly ? "and visibility = 'public' and scan_state = 'clean'" : ''} order by created_at`,
      [ticketId],
    );
  }

  byKey(tx: Tx, key: string): Promise<AttachmentRow | undefined> {
    return this.maybeOne<AttachmentRow>(tx, 'select * from acct.attachments where s3_key = $1', [key]);
  }

  insert(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      key: string;
      origin: string;
      visibility: string;
      uploadedBy: string;
      uploadedByName: string;
      commentId?: string | null;
      workNoteId?: string | null;
      reEncode?: Record<string, unknown> | null;
    },
  ): Promise<AttachmentRow> {
    return this.one<AttachmentRow>(
      tx,
      'attachment',
      `insert into acct.attachments (account_id, ticket_id, comment_id, work_note_id, file_name, content_type, size_bytes, s3_key, origin, visibility, uploaded_by, uploaded_by_name, re_encode)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) returning *`,
      [
        input.accountId,
        input.ticketId,
        input.commentId ?? null,
        input.workNoteId ?? null,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.key,
        input.origin,
        input.visibility,
        input.uploadedBy,
        input.uploadedByName,
        input.reEncode ? JSON.stringify(input.reEncode) : null,
      ],
    );
  }

  setScan(
    tx: Tx,
    id: string,
    state: 'clean' | 'quarantined',
    detail: Record<string, unknown>,
    newKey?: string,
  ): Promise<AttachmentRow> {
    return this.one<AttachmentRow>(
      tx,
      'attachment',
      `update acct.attachments set scan_state = $2, scan_detail = $3, s3_key = coalesce($4, s3_key) where id = $1 returning *`,
      [id, state, JSON.stringify(detail), newKey ?? null],
    );
  }

  setSize(tx: Tx, id: string, size: number): Promise<AttachmentRow> {
    return this.one<AttachmentRow>(
      tx,
      'attachment',
      `update acct.attachments set size_bytes = $2 where id = $1 returning *`,
      [id, size],
    );
  }

  softDelete(tx: Tx, id: string): Promise<number> {
    return this.count(tx, 'update acct.attachments set deleted_at = now() where id = $1 and deleted_at is null', [id]);
  }
}

export class PresignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  @Matches(/^[^\\/:*?"<>|\r\n]+$/)
  file_name!: string;

  @IsString()
  @MaxLength(120)
  content_type!: string;

  @IsInt()
  @Min(1)
  size_bytes!: number;
}

/** Scanner interface: GuardDuty results arrive through the worker; the local scanner runs inline and recognises EICAR. */
export interface Scanner {
  scan(body: Buffer): Promise<{ verdict: 'clean' | 'quarantined'; detail: Record<string, unknown> }>;
}

export class LocalScanner implements Scanner {
  async scan(body: Buffer): Promise<{ verdict: 'clean' | 'quarantined'; detail: Record<string, unknown> }> {
    const text = body.subarray(0, 4096).toString('latin1');
    if (text.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'))
      return { verdict: 'quarantined', detail: { engine: 'local', threat: 'EICAR-Test-File' } };
    return { verdict: 'clean', detail: { engine: 'local' } };
  }
}

@Injectable()
export class AttachmentsService {
  private readonly scanner: Scanner = new LocalScanner();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly attachments: AttachmentsRepository,
    private readonly tickets: TicketsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    private readonly outbox: OutboxService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  list(principal: Principal, key: string): Promise<AttachmentRow[]> {
    const run = principal.kind === 'portal' ? this.uow.run.bind(this.uow) : this.uow.run.bind(this.uow);
    return run(principal, async (tx) => {
      const ticket = await this.loadTicket(tx, key);
      return this.attachments.ofTicket(tx, ticket.id, principal.kind === 'portal');
    });
  }

  async presign(
    principal: Principal,
    ctx: RequestContext,
    key: string,
    dto: PresignDto,
  ): Promise<{ attachment: AttachmentRow; upload: Awaited<ReturnType<ObjectStore['presignUpload']>> }> {
    const contentType = dto.content_type.toLowerCase().split(';')[0].trim();
    const extension = dto.file_name.toLowerCase().split('.').pop() ?? '';
    const extensions = Object.hasOwn(ALLOWED_TYPES, contentType) ? ALLOWED_TYPES[contentType] : undefined;
    if (!extensions || !extensions.includes(extension)) {
      await this.security.write({
        type: 'abuse.upload.rejected',
        outcome: 'denied',
        actorKind: 'user',
        actorId: principal.userId,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        attrs: { reason: 'type', contentType, extension },
      });
      throw new BadRequestException({ code: 'unsupported_type', content_type: contentType, extension });
    }
    const work = async (tx: Tx) => {
      const ticket = await this.loadTicket(tx, key);
      if (ticket.state === 'closed' || ticket.state === 'cancelled')
        throw new BadRequestException({ code: 'ticket_closed' });
      const maxBytes = await this.maxBytes(tx, ticket.account_id);
      if (dto.size_bytes > maxBytes) {
        await this.security.write({
          type: 'abuse.upload.rejected',
          outcome: 'denied',
          accountId: ticket.account_id,
          actorKind: 'user',
          actorId: principal.userId,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          attrs: { reason: 'size', size: dto.size_bytes, max: maxBytes },
        });
        throw new BadRequestException({ code: 'too_large', max_bytes: maxBytes });
      }
      const objectKey = `accounts/${ticket.account_id}/tickets/${ticket.id}/${randomUUID()}-${dto.file_name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)}`;
      const row = await this.attachments.insert(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        fileName: dto.file_name,
        contentType,
        sizeBytes: dto.size_bytes,
        key: objectKey,
        origin: principal.kind === 'portal' ? 'portal' : 'internal',
        visibility: principal.kind === 'portal' ? 'public' : 'internal',
        uploadedBy: principal.userId,
        uploadedByName: principal.displayName,
      });
      const upload = await this.store.presignUpload(objectKey, {
        contentType,
        maxBytes: Math.min(dto.size_bytes, maxBytes),
      });
      await this.audit.account(tx, ticket.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'attachment',
          entityId: row.id,
          ticketId: ticket.id,
          eventType: 'attachment.created',
          newValue: { file_name: row.file_name, size: dto.size_bytes, visibility: row.visibility },
        },
      ]);
      return { attachment: row, upload };
    };
    return principal.kind === 'portal' ? this.uow.portalWrite(principal, work) : this.uow.run(principal, work);
  }

  /** After the upload: verify the object exists, then scan (inline locally; the worker consumer in AWS). */
  async confirm(
    principal: Principal,
    ctx: RequestContext,
    key: string,
    attachmentId: string,
    options: { visibility?: 'public' | 'internal' } = {},
  ): Promise<AttachmentRow> {
    const work = async (tx: Tx) => {
      const ticket = await this.loadTicket(tx, key);
      const row = await this.attachments.byId(tx, attachmentId);
      if (row.ticket_id !== ticket.id) throw new NotFoundException({ code: 'not_found', entity: 'attachment' });
      const head = await this.store.headObject(row.s3_key);
      if (!head) throw new BadRequestException({ code: 'upload_missing' });
      if (head.size > Number(row.size_bytes)) throw new BadRequestException({ code: 'size_mismatch' });
      await this.attachments.setSize(tx, row.id, head.size);
      if (options.visibility && principal.kind !== 'portal') {
        await tx.query('update acct.attachments set visibility = $2 where id = $1', [row.id, options.visibility]);
      }
      if (this.store.kind === 'local') {
        const verdict = await this.scanner.scan(await this.store.getObject(row.s3_key));
        return this.applyScan(tx, row, verdict.verdict, verdict.detail, ctx);
      }
      return this.attachments.byId(tx, row.id);
    };
    return principal.kind === 'portal' ? this.uow.portalWrite(principal, work) : this.uow.run(principal, work);
  }

  /**
   * Registers a file that arrived from a connector (ServiceNow Sync
   * technical 3.4 step 6). The bytes are already in hand, so the presign
   * dance does not apply, but everything after it does: the object goes to
   * the store, the row is written, and the file passes through the same
   * scan gate as an upload, so a quarantined file is moved and notified
   * about exactly as one a person uploaded. Runs in the caller's
   * transaction.
   */
  async ingest(
    tx: Tx,
    input: {
      accountId: string;
      ticketId: string;
      fileName: string;
      contentType: string;
      body: Buffer;
      uploadedBy: string;
      uploadedByName: string;
      visibility?: 'public' | 'internal';
    },
    ctx: RequestContext,
  ): Promise<AttachmentRow> {
    // Bytes in hand, so the image re-encode applies here exactly as it does
    // to an image off an email: normalised format, no metadata, dimensions
    // capped, before storage and before the scan gate (Security section 6).
    let body = input.body;
    let storedType = input.contentType.toLowerCase();
    let storedName = input.fileName;
    let reEncode: Record<string, unknown> | null = null;
    let undecodable: string | null = null;
    if (isReEncodedImage(storedType)) {
      try {
        const encoded = await reEncodeImage(input.body, storedType, input.fileName);
        body = encoded.body;
        storedType = encoded.contentType;
        storedName = encoded.fileName;
        reEncode = encoded.detail;
      } catch (error) {
        undecodable =
          error instanceof ImageNotDecodableError ? error.reason : `the image could not be re-encoded: ${error}`;
      }
    }
    const safeName = storedName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const objectKey = `accounts/${input.accountId}/tickets/${input.ticketId}/${randomUUID()}-${safeName}`;
    await this.store.putObject(objectKey, body, storedType);
    const row = await this.attachments.insert(tx, {
      accountId: input.accountId,
      ticketId: input.ticketId,
      fileName: storedName,
      contentType: storedType,
      sizeBytes: body.length,
      key: objectKey,
      origin: 'sync',
      visibility: input.visibility ?? 'public',
      uploadedBy: input.uploadedBy,
      uploadedByName: input.uploadedByName,
      reEncode,
    });
    if (undecodable)
      return this.applyScan(
        tx,
        row,
        'quarantined',
        { reason: 'image_not_decodable', detail: undecodable, declared_content_type: input.contentType },
        ctx,
      );
    const verdict = await this.scanner.scan(body);
    return this.applyScan(tx, row, verdict.verdict, verdict.detail, ctx);
  }

  /** The scan result consumer (worker in AWS, inline locally): quarantine moves the object and notifies. */
  async applyScan(
    tx: Tx,
    row: AttachmentRow,
    verdict: 'clean' | 'quarantined',
    detail: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<AttachmentRow> {
    if (verdict === 'clean') {
      const clean = await this.attachments.setScan(tx, row.id, 'clean', detail);
      // A file that passed the scan announces itself, so a connector can
      // send it on; one that failed never does (the quarantine event
      // below is for the people who need to know, not for a client).
      await this.outbox.write(tx, {
        accountId: row.account_id,
        aggregate: 'ticket',
        aggregateId: row.ticket_id,
        eventType: 'attachment.scanned',
        correlationId: ctx.requestId ?? row.id,
        origin: ctx.origin ?? 'user',
        payload: { attachment_id: row.id, visibility: clean.visibility },
      });
      return clean;
    }
    const quarantineKey = row.s3_key.replace(/^accounts\//, 'quarantine/accounts/');
    await this.store.moveObject(row.s3_key, quarantineKey);
    const updated = await this.attachments.setScan(tx, row.id, 'quarantined', detail, quarantineKey);
    const ticket = await this.tickets.byId(tx, row.ticket_id);
    await this.audit.account(tx, row.account_id, { kind: 'system', id: 'scanner', name: 'Malware scan' }, ctx, [
      {
        entityKind: 'attachment',
        entityId: row.id,
        ticketId: row.ticket_id,
        eventType: 'updated',
        field: 'scan_state',
        oldValue: 'pending',
        newValue: 'quarantined',
      },
    ]);
    await this.security.write(
      {
        type: 'data.attachment.quarantined',
        outcome: 'withheld',
        accountId: row.account_id,
        actorKind: 'system',
        actorId: 'scanner',
        requestId: ctx.requestId,
        entityKind: 'attachment',
        entityId: row.id,
        attrs: { file_name: row.file_name, threat: detail.threat ?? null },
      },
      tx,
    );
    await this.outbox.write(tx, {
      accountId: row.account_id,
      aggregate: 'ticket',
      aggregateId: row.ticket_id,
      eventType: 'attachment.quarantined',
      correlationId: ctx.requestId ?? row.id,
      origin: 'system',
      payload: { attachment_id: row.id },
    });
    const recipients = new Set<string>([row.uploaded_by]);
    if (ticket.assignee_id) recipients.add(ticket.assignee_id);
    for (const recipient of recipients) {
      await this.notifications.upsert(tx, {
        accountId: row.account_id,
        recipientId: recipient,
        type: 'attachment.quarantined',
        title: `An attachment on ${ticketKey(ticket.number)} was quarantined`,
        body: row.file_name,
        targetKind: 'ticket',
        targetId: ticket.id,
        link: `/tickets/${ticketKey(ticket.number)}`,
        collapseKey: `quarantined:${row.id}:${recipient}`,
      });
    }
    return updated;
  }

  async downloadUrl(
    principal: Principal,
    ctx: RequestContext,
    attachmentId: string,
  ): Promise<{ url: string; file_name: string; content_type: string }> {
    return this.uow.run(principal, async (tx) => {
      const row = await this.attachments.byId(tx, attachmentId);
      if (principal.kind === 'portal' && row.visibility !== 'public')
        throw new NotFoundException({ code: 'not_found', entity: 'attachment' });
      if (row.scan_state !== 'clean') {
        await this.security.write({
          type: 'data.attachment.downloaded',
          outcome: 'denied',
          accountId: row.account_id,
          actorKind: principal.kind === 'portal' ? 'portal_user' : 'user',
          actorId: principal.userId,
          principalKind: principal.kind,
          requestId: ctx.requestId,
          entityKind: 'attachment',
          entityId: row.id,
          attrs: { scan_state: row.scan_state },
        });
        throw new ForbiddenException({ code: row.scan_state === 'pending' ? 'scan_pending' : 'quarantined' });
      }
      const url = await this.store.presignDownload(row.s3_key, {
        fileName: row.file_name,
        contentType: row.content_type,
      });
      await this.security.write({
        type: 'data.attachment.downloaded',
        outcome: 'success',
        accountId: row.account_id,
        actorKind: principal.kind === 'portal' ? 'portal_user' : 'user',
        actorId: principal.userId,
        actorName: principal.displayName,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        entityKind: 'attachment',
        entityId: row.id,
        attrs: { file_name: row.file_name, size: Number(row.size_bytes) },
      });
      return { url, file_name: row.file_name, content_type: row.content_type };
    });
  }

  remove(principal: Principal, ctx: RequestContext, attachmentId: string): Promise<void> {
    return this.uow.run(principal, async (tx) => {
      const row = await this.attachments.byId(tx, attachmentId);
      await this.attachments.softDelete(tx, row.id);
      await this.audit.account(tx, row.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'attachment',
          entityId: row.id,
          ticketId: row.ticket_id,
          eventType: 'attachment.deleted',
          oldValue: { file_name: row.file_name },
        },
      ]);
    });
  }

  private async maxBytes(tx: Tx, accountId: string): Promise<number> {
    const row = await tx.query<{ attachment_max_bytes: string }>(
      'select attachment_max_bytes from acct.account_settings where account_id = $1',
      [accountId],
    );
    return Number(row.rows[0]?.attachment_max_bytes ?? 26214400);
  }

  private loadTicket(tx: Tx, key: string) {
    const number = key.match(/^CS(\d{7,})$/i) ? String(Number(key.slice(2))) : undefined;
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, key);
  }
}

@ApiTags('attachments')
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('tickets/:key/attachments')
  @RequirePermission('tickets:view')
  list(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.attachments.list(principal, key);
  }

  @Post('tickets/:key/attachments/presign')
  @RequirePermission('tickets:work')
  presign(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: PresignDto,
  ) {
    return this.attachments.presign(principal, ctx, key, dto);
  }

  @Post('tickets/:key/attachments/:id/confirm')
  @RequirePermission('tickets:work')
  confirm(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { visibility?: 'public' | 'internal' },
  ) {
    return this.attachments.confirm(principal, ctx, key, id, {
      visibility: body?.visibility === 'public' || body?.visibility === 'internal' ? body.visibility : undefined,
    });
  }

  @Get('attachments/:id/download')
  @RequirePermission('tickets:view')
  download(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachments.downloadUrl(principal, ctx, id);
  }

  @Delete('attachments/:id')
  @HttpCode(204)
  @RequirePermission('tickets:work')
  remove(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachments.remove(principal, ctx, id);
  }
}

@ApiTags('portal')
@ApiBearerAuth()
@Controller('portal')
@RealmOf('portal')
@RequirePermission('portal:submit')
export class PortalAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('tickets/:key/attachments')
  list(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.attachments.list(principal, key);
  }

  @Post('tickets/:key/attachments/presign')
  presign(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() dto: PresignDto,
  ) {
    return this.attachments.presign(principal, ctx, key, dto);
  }

  @Post('tickets/:key/attachments/:id/confirm')
  confirm(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachments.confirm(principal, ctx, key, id);
  }

  @Get('attachments/:id/download')
  download(
    @CurrentPrincipal() principal: Principal,
    @RequestCtx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachments.downloadUrl(principal, ctx, id);
  }
}

@Module({
  imports: [TicketsCoreModule],
  providers: [AttachmentsRepository, AttachmentsService],
  exports: [AttachmentsService, AttachmentsRepository],
})
export class AttachmentsCoreModule {}

@Module({
  imports: [AttachmentsCoreModule],
  controllers: [AttachmentsController, PortalAttachmentsController],
  exports: [AttachmentsCoreModule],
})
export class AttachmentsModule {}
