import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { actorOf, AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service.js';
import { SecurityEventsService } from '../../common/events/security-events.service.js';
import { MAIL_TRANSPORT, OBJECT_STORE } from '../../common/storage/storage.module.js';
import type { MailTransport } from '../../common/mail/mail-transport.js';
import type { ObjectStore } from '../../common/storage/object-store.js';
import { loadEnv } from '../../config/env.js';
import { DbPools } from '../../db/pool.js';
import type { Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';
import { scoreLoop } from '../../domain/email/loop-guard.js';
import { stripReply } from '../../domain/email/stripper.js';
import {
  matchThread,
  newEmailToken,
  normaliseMessageId,
  plusTokenOf,
  type MatchedBy,
} from '../../domain/email/thread-matcher.js';
import { AccountsRepository } from '../admin/accounts/accounts.repository.js';
import { UsersRepository } from '../admin/users/users.repository.js';
import { ALLOWED_TYPES, AttachmentsRepository, AttachmentsService } from '../attachments/attachments.module.js';
import { ImageNotDecodableError, isReEncodedImage, reEncodeImage } from '../../common/images/reencode.js';
import { TicketsRepository, ticketKey, type TicketRow } from '../tickets/tickets.repository.js';
import { TicketsService } from '../tickets/tickets.service.js';
import type { OutboxRow } from '../../worker/outbox-dispatcher.js';
import { EmailRepository, type AliasRow, type InboundRow } from './email.repository.js';
import {
  acknowledgement,
  publicComment,
  resolved,
  TEMPLATE_VERSION,
  type Branding,
  type Rendered,
} from './templates.js';

/**
 * Email intake and outbound (02-modules/email-intake; P1.6.3, P1.6.4,
 * P2.18.1 cut). Inbound: parse, resolve the alias to the account before any
 * account row is written, dedupe on sys.inbox, score loops, resolve the
 * sender, match the thread inside the account, strip the reply, append or
 * create through the ticket service, quarantine unknown senders. Outbound:
 * typed templates, stable subject key, Message-ID and References threading,
 * per-account sender identity with a plus-address reply path, suppression
 * list, delivery state from the SES event webhook.
 */
export type Disposition = 'created' | 'appended' | 'quarantined' | 'suppressed' | 'rejected' | 'duplicate';

export interface InboundResult {
  readonly disposition: Disposition;
  readonly accountId?: string;
  readonly ticketKey?: string;
  readonly inboundId?: string;
  readonly reason?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly pools: DbPools,
    private readonly email: EmailRepository,
    private readonly tickets: TicketsRepository,
    private readonly ticketService: TicketsService,
    private readonly attachments: AttachmentsRepository,
    private readonly attachmentService: AttachmentsService,
    private readonly accounts: AccountsRepository,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly security: SecurityEventsService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  // Aliases -----------------------------------------------------------------

  aliases(principal: Principal, accountId: string) {
    return this.uow.run(principal, (tx) => this.email.aliasesOf(tx, accountId));
  }

  async createAlias(
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    input: { address: string; kind?: string; default_ticket_type?: string },
  ) {
    return this.uow.run(principal, async (tx) => {
      const alias = await this.email.insertAlias(tx, {
        accountId,
        address: input.address,
        kind: input.kind ?? 'alias',
        defaultTicketType: input.default_ticket_type,
      });
      await this.audit.account(tx, accountId, actorOf(principal), ctx, [
        {
          entityKind: 'inbound_alias',
          entityId: alias.id,
          eventType: 'created',
          newValue: { address: alias.address, kind: alias.kind },
        },
      ]);
      return alias;
    });
  }

  async setAliasState(principal: Principal, ctx: RequestContext, aliasId: string, enable: boolean) {
    return this.uow.run(principal, async (tx) => {
      const before = await this.email.aliasById(tx, aliasId);
      const after = await this.email.setAliasState(
        tx,
        aliasId,
        enable ? 'active' : 'disabled_by_admin',
        enable ? null : 'disabled by administrator',
      );
      await this.audit.account(tx, before.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'inbound_alias',
          entityId: aliasId,
          eventType: 'updated',
          field: 'state',
          oldValue: before.state,
          newValue: after.state,
        },
      ]);
      if (!enable) {
        await this.security.write(
          {
            type: 'admin.alias.disabled',
            outcome: 'success',
            accountId: before.account_id,
            actorKind: 'user',
            actorId: principal.userId,
            actorName: principal.displayName,
            principalKind: principal.kind,
            requestId: ctx.requestId,
            entityKind: 'inbound_alias',
            entityId: aliasId,
            attrs: { address: before.address },
          },
          tx,
        );
      }
      return after;
    });
  }

  // Inbound -----------------------------------------------------------------

  /** Processes one raw RFC 5322 message. Runs on the worker role; the account binding is set once the alias resolved. */
  async processInbound(raw: Buffer, receivedAt: Date = new Date()): Promise<InboundResult> {
    if (!this.pools.has('worker')) throw new ServiceUnavailableException({ code: 'worker_pool_unavailable' });
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const messageId = normaliseMessageId(parsed.messageId) ?? `<generated-${randomUUID()}@xms>`;
    const recipients = [
      ...addresses(parsed.to),
      ...addresses(parsed.cc),
      ...headerAddresses(parsed, 'delivered-to'),
      ...headerAddresses(parsed, 'x-original-to'),
    ];
    const aliasAddress = await this.resolveAliasAddress(recipients);

    if (!aliasAddress) {
      await this.uow.worker([], async (tx) => {
        const inboxId = await this.email.claimInbox(tx, messageId, null, {
          subject: parsed.subject ?? '',
          to: recipients,
        });
        if (inboxId) await this.email.finishInbox(tx, inboxId, 'failed', 'no alias');
      });
      return { disposition: 'rejected', reason: 'no_alias' };
    }
    const accountId = aliasAddress.accountId;
    const fromAddress = (parsed.from?.value[0]?.address ?? '').toLowerCase();
    const fromName = parsed.from?.value[0]?.name ?? '';
    if (!fromAddress) return { disposition: 'rejected', reason: 'no_sender', accountId };

    return this.uow.worker([accountId], async (tx) => {
      const inboxId = await this.email.claimInbox(tx, messageId, accountId, {
        subject: parsed.subject ?? '',
        from: fromAddress,
      });
      if (!inboxId) return { disposition: 'duplicate', accountId };
      const alias = (await this.email.aliasByAddress(tx, aliasAddress.address))!;
      const rawKey = `accounts/${accountId}/email/inbound/${receivedAt.toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}.eml`;
      await this.store.putObject(rawKey, raw, 'message/rfc822');

      const references = (
        Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []
      )
        .map((r) => normaliseMessageId(r)!)
        .filter(Boolean);
      const subject = parsed.subject ?? '';
      const counts = await this.email.senderCounts(tx, accountId, alias.id, fromAddress, subject);
      const ownSenders = new Set(await this.email.ownSenderAddresses(tx, accountId));
      const ownIds = new Set<string>();
      const headers: Record<string, string> = {};
      for (const [name, value] of parsed.headers)
        headers[name] = Array.isArray(value)
          ? String(value[0])
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      const loop = scoreLoop({
        headers,
        subject,
        fromAddress,
        references,
        ownMessageIds: ownIds,
        ownSenderAddresses: ownSenders,
        senderCountLast10Minutes: counts.sender,
        sameSubjectCountLast10Minutes: counts.subject,
      });

      const sender = await this.resolveSender(tx, accountId, fromAddress, fromName);
      const match = await matchThread(
        { recipients, inReplyTo: parsed.inReplyTo, references, subject },
        {
          byPlusToken: (token) => this.email.ticketByEmailToken(tx, token),
          byMessageId: (id) => this.email.ticketByMessageId(tx, id),
          byTicketKey: async (key) => {
            const ticket = await this.email.ticketByKey(tx, key);
            if (!ticket) return undefined;
            const closedTooLong = ticket.closed_at
              ? Date.now() - new Date(ticket.closed_at).getTime() > 14 * 86_400_000
              : false;
            return { ticketId: ticket.id, closedTooLong };
          },
        },
      );
      const stripped = stripReply(parsed.text ?? htmlToText(parsed.html || ''));
      const bodyText = stripped.text || '(empty message)';

      const base: Omit<
        InboundRow,
        'id' | 'created_at' | 'disposition' | 'suppression_reason' | 'matched_by' | 'ticket_id' | 'comment_id'
      > = {
        account_id: accountId,
        alias_id: alias.id,
        raw_s3_key: rawKey,
        message_id: messageId,
        in_reply_to: normaliseMessageId(parsed.inReplyTo) ?? null,
        references,
        plus_token: plusTokenOf(recipients) ?? null,
        from_address: fromAddress,
        from_name: fromName,
        to_addresses: addresses(parsed.to),
        cc_addresses: addresses(parsed.cc),
        subject,
        received_at: receivedAt.toISOString(),
        sender_resolution: sender.resolution,
        contact_id: sender.contactId ?? null,
        user_id: sender.userId ?? null,
        loop_score: loop.score,
        loop_signals: loop.signals,
        stripped_body_text: bodyText,
        attachment_count: parsed.attachments.length,
        size_bytes: raw.length,
      };
      const ctx: RequestContext = { requestId: `email:${inboxId}` };

      if (loop.suppress) {
        const row = await this.email.insertInbound(tx, {
          ...base,
          disposition: 'suppressed',
          suppression_reason: loop.signals[0] ?? 'loop',
          matched_by: null,
          ticket_id: match?.ticketId ?? null,
          comment_id: null,
        });
        await this.email.finishInbox(tx, inboxId, 'applied');
        await this.loopDetection(tx, alias, fromAddress, ctx);
        return { disposition: 'suppressed', accountId, inboundId: row.id, reason: loop.signals[0] };
      }

      const principal = this.principalFor(sender, accountId, fromAddress, fromName);
      if (match) {
        const ticket = await this.tickets.byId(tx, match.ticketId);
        const comment = (await this.ticketService.addComment(principal, ctx, ticket.id, { body: bodyText }, tx)) as {
          id: string;
        };
        await this.storeAttachments(tx, parsed, ticket, principal, ctx, comment.id);
        const row = await this.email.insertInbound(tx, {
          ...base,
          disposition: 'appended',
          suppression_reason: null,
          matched_by: match.matchedBy as MatchedBy,
          ticket_id: ticket.id,
          comment_id: comment.id,
        });
        await this.email.finishInbox(tx, inboxId, 'applied');
        return { disposition: 'appended', accountId, ticketKey: ticketKey(ticket.number), inboundId: row.id };
      }
      if (sender.resolution === 'unknown') {
        const row = await this.email.insertInbound(tx, {
          ...base,
          disposition: 'quarantined',
          suppression_reason: null,
          matched_by: null,
          ticket_id: null,
          comment_id: null,
        });
        await this.email.insertQuarantine(tx, accountId, row.id, 'unknown_sender');
        await this.email.finishInbox(tx, inboxId, 'applied');
        return { disposition: 'quarantined', accountId, inboundId: row.id, reason: 'unknown_sender' };
      }
      const created = await this.createFromInbound(
        tx,
        principal,
        ctx,
        accountId,
        alias,
        subject,
        bodyText,
        fromAddress,
        fromName,
        parsed,
      );
      const row = await this.email.insertInbound(tx, {
        ...base,
        disposition: 'created',
        suppression_reason: null,
        matched_by: null,
        ticket_id: created.id,
        comment_id: null,
      });
      await this.email.finishInbox(tx, inboxId, 'applied');
      return { disposition: 'created', accountId, ticketKey: ticketKey(created.number), inboundId: row.id };
    });
  }

  private async createFromInbound(
    tx: Tx,
    principal: Principal,
    ctx: RequestContext,
    accountId: string,
    alias: AliasRow,
    subject: string,
    body: string,
    fromAddress: string,
    fromName: string,
    parsed: ParsedMail,
  ): Promise<TicketRow> {
    const view = await this.ticketService.create(
      principal,
      ctx,
      {
        account_id: accountId,
        type: (alias.default_ticket_type as 'incident') ?? 'incident',
        short_description: (subject || '(no subject)').replace(/^\s*(?:re|fwd?|aw|wg):\s*/i, '').slice(0, 300),
        description: body,
        requester_email: fromAddress,
        requester_name: fromName || fromAddress,
        source: 'email' as never,
      },
      tx,
    );
    const ticket = await this.tickets.byId(tx, view.id);
    await this.tickets.update(tx, ticket.id, ticket.version, { email_token: newEmailToken() }).catch(() => undefined);
    await this.storeAttachments(tx, parsed, ticket, principal, ctx, null);
    return this.tickets.byId(tx, ticket.id);
  }

  private async storeAttachments(
    tx: Tx,
    parsed: ParsedMail,
    ticket: TicketRow,
    principal: Principal,
    ctx: RequestContext,
    commentId: string | null,
  ): Promise<void> {
    // The account's own per-file ceiling, applied here because nothing
    // upstream of an inbound message enforces one: SES caps the whole
    // message, not each part, and the re-encode below decodes whatever it
    // is handed.
    const maxBytes = await this.attachmentService.maxBytes(tx, ticket.account_id);
    for (const attachment of parsed.attachments) {
      const contentType = (attachment.contentType || 'application/octet-stream').toLowerCase();
      const fileName = (attachment.filename || `attachment-${randomUUID().slice(0, 8)}`).replace(
        /[\\/:*?"<>|\r\n]/g,
        '_',
      );
      const extension = fileName.toLowerCase().split('.').pop() ?? '';
      // An own-key lookup: `constructor` and `toString` are legal MIME
      // strings and would otherwise return an inherited function.
      const extensions = Object.hasOwn(ALLOWED_TYPES, contentType) ? ALLOWED_TYPES[contentType] : undefined;
      if (!extensions?.includes(extension)) {
        await this.security.write(
          {
            type: 'abuse.upload.rejected',
            outcome: 'denied',
            accountId: ticket.account_id,
            actorKind: 'system',
            actorId: 'email',
            requestId: ctx.requestId,
            attrs: { reason: 'type', contentType, extension, via: 'email' },
          },
          tx,
        );
        continue;
      }
      if (attachment.content.length > maxBytes) {
        await this.security.write(
          {
            type: 'abuse.upload.rejected',
            outcome: 'denied',
            accountId: ticket.account_id,
            actorKind: 'system',
            actorId: 'email',
            requestId: ctx.requestId,
            attrs: { reason: 'size', size: attachment.content.length, max: maxBytes, via: 'email' },
          },
          tx,
        );
        continue;
      }
      // Inline and attached images are decoded and written out again before
      // anything is stored, so what lands in the object store is built from
      // the pixels and carries none of the original container (Email Intake
      // technical 3 step 4; Security & Tenancy section 6). The scan gate
      // then sees the file that will actually be served.
      let body = attachment.content;
      let storedType = contentType;
      let storedName = fileName;
      let reEncode: Record<string, unknown> | null = null;
      let undecodable: string | null = null;
      let undecodableCode: 'image_not_decodable' | 'image_too_large' = 'image_not_decodable';
      if (isReEncodedImage(contentType)) {
        try {
          const encoded = await reEncodeImage(attachment.content, contentType, fileName);
          body = encoded.body;
          storedType = encoded.contentType;
          storedName = encoded.fileName;
          reEncode = encoded.detail;
        } catch (error) {
          undecodable =
            error instanceof ImageNotDecodableError ? error.reason : `the image could not be re-encoded: ${error}`;
          if (error instanceof ImageNotDecodableError) undecodableCode = error.code;
        }
      }
      const key = `accounts/${ticket.account_id}/tickets/${ticket.id}/${randomUUID()}-${storedName.slice(0, 120)}`;
      await this.store.putObject(key, body, storedType);
      const row = await this.attachments.insert(tx, {
        accountId: ticket.account_id,
        ticketId: ticket.id,
        commentId,
        fileName: storedName,
        contentType: storedType,
        sizeBytes: body.length,
        key,
        origin: 'email',
        visibility: 'public',
        uploadedBy: principal.userId,
        uploadedByName: principal.displayName,
        reEncode,
      });
      // A file that says it is an image and is not one is not served on a
      // guess: it goes to quarantine through the same gate a threat does,
      // with the reason in the words the reviewer reads.
      if (undecodable) {
        await this.attachmentService.applyScan(
          tx,
          row,
          'quarantined',
          { reason: undecodableCode, detail: undecodable, declared_content_type: contentType },
          ctx,
        );
        continue;
      }
      const verdict = await this.attachmentService['scanner'].scan(body);
      await this.attachmentService.applyScan(tx, row, verdict.verdict, verdict.detail, ctx);
    }
  }

  private async resolveAliasAddress(recipients: string[]): Promise<{ address: string; accountId: string } | undefined> {
    for (const recipient of recipients) {
      const address = recipient.toLowerCase().replace(/\+[a-z2-7]{12}@/, '@');
      const accountId = await this.uow.worker([], (tx) => this.email.accountForAlias(tx, address));
      if (accountId) return { address, accountId };
    }
    return undefined;
  }

  private async resolveSender(
    tx: Tx,
    accountId: string,
    fromAddress: string,
    fromName: string,
  ): Promise<{ resolution: InboundRow['sender_resolution']; contactId?: string; userId?: string; name: string }> {
    const contact = await this.tickets.contactByEmail(tx, accountId, fromAddress);
    if (contact)
      return {
        resolution: contact.portal_user_id ? 'portal_user' : 'known_contact',
        contactId: contact.id,
        name: contact.display_name || fromName,
      };
    const user = await this.users.byEmail(tx, fromAddress);
    if (user && user.kind === 'internal' && user.status === 'active')
      return { resolution: 'known_internal', userId: user.id, name: `${user.first_name} ${user.last_name}`.trim() };
    if (user && user.kind === 'portal' && user.account_id === accountId) {
      const created = await this.tickets.insertContact(
        tx,
        accountId,
        fromAddress,
        `${user.first_name} ${user.last_name}`.trim() || fromAddress,
        user.id,
      );
      return { resolution: 'portal_user', contactId: created.id, name: created.display_name };
    }
    return { resolution: 'unknown', name: fromName || fromAddress };
  }

  private principalFor(
    sender: { resolution: string; contactId?: string; userId?: string; name: string },
    accountId: string,
    email: string,
    fromName: string,
  ): Principal {
    if (sender.resolution === 'known_internal') {
      return {
        kind: 'internal',
        userId: sender.userId!,
        email,
        displayName: sender.name || fromName || email,
        accountIds: [accountId],
        permissions: new Set(),
        tokenType: 'dev',
      };
    }
    return {
      kind: 'portal',
      userId: sender.contactId ?? `email:${email}`,
      email,
      displayName: sender.name || fromName || email,
      accountIds: [accountId],
      permissions: new Set(),
      tokenType: 'dev',
    };
  }

  private async loopDetection(tx: Tx, alias: AliasRow, fromAddress: string, ctx: RequestContext): Promise<void> {
    const counts = await this.email.suppressionsInWindow(tx, alias.account_id, alias.id, fromAddress);
    if (counts.suppressed < 3 && counts.flagged < 5) return;
    await this.security.write(
      {
        type: 'abuse.email.loop_suspected',
        outcome: 'withheld',
        accountId: alias.account_id,
        actorKind: 'system',
        actorId: 'loop_guard',
        requestId: ctx.requestId,
        entityKind: 'inbound_alias',
        entityId: alias.id,
        attrs: { from: fromAddress, ...counts },
      },
      tx,
    );
    if (alias.state === 'active' && loadEnv().NODE_ENV !== 'production') {
      // Month 2 restores automatic alias disable; for the month the alias stays up and the alarm fires (Thirty-Day Build section 5).
      this.logger.warn(`loop suspected on alias ${alias.address} from ${fromAddress}`);
    }
  }

  // Quarantine --------------------------------------------------------------

  quarantine(principal: Principal, state = 'open') {
    return this.uow.run(principal, (tx) => this.email.quarantineList(tx, [...principal.accountIds], state));
  }

  async decide(principal: Principal, ctx: RequestContext, id: string, decision: string) {
    return this.uow.run(principal, async (tx) => {
      const item = await this.email.quarantineById(tx, id);
      if (item.state !== 'open') throw new ConflictException({ code: 'already_decided' });
      const inbound = await this.email.inboundById(tx, item.inbound_message_id);
      const alias = await this.email.aliasById(tx, inbound.alias_id);
      let ticketId: string | null = null;
      if (decision === 'create_contact_and_ticket' || decision === 'create_ticket_once') {
        const raw = await this.store.getObject(inbound.raw_s3_key);
        const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
        const contactName = inbound.from_name || inbound.from_address;
        const contact =
          decision === 'create_contact_and_ticket'
            ? ((await this.tickets.contactByEmail(tx, item.account_id, inbound.from_address)) ??
              (await this.tickets.insertContact(tx, item.account_id, inbound.from_address, contactName)))
            : undefined;
        const senderPrincipal: Principal = {
          kind: 'portal',
          userId: contact?.id ?? `email:${inbound.from_address}`,
          email: inbound.from_address,
          displayName: contactName,
          accountIds: [item.account_id],
          permissions: new Set(),
          tokenType: 'dev',
        };
        const ticket = await this.createFromInbound(
          tx,
          senderPrincipal,
          ctx,
          item.account_id,
          alias,
          inbound.subject,
          inbound.stripped_body_text,
          inbound.from_address,
          contactName,
          parsed,
        );
        ticketId = ticket.id;
        if (decision === 'create_ticket_once' && ticket.requester_contact_id) {
          // No lasting contact: the requester is recorded on the ticket only.
          await tx
            .query(
              'delete from acct.contacts where id = $1 and not exists (select 1 from acct.tickets where requester_contact_id = $1 and id <> $2)',
              [ticket.requester_contact_id, ticket.id],
            )
            .catch(() => undefined);
        }
      }
      const decided = await this.email.decideQuarantine(tx, id, item.version, decision, principal.userId, ticketId);
      await this.audit.account(tx, item.account_id, actorOf(principal), ctx, [
        {
          entityKind: 'quarantine_item',
          entityId: id,
          eventType: 'updated',
          field: 'decision',
          newValue: { decision, ticket_id: ticketId },
        },
      ]);
      return { ...decided, ticket_key: ticketId ? ticketKey((await this.tickets.byId(tx, ticketId)).number) : null };
    });
  }

  // Thread view and raw download --------------------------------------------

  thread(principal: Principal, key: string) {
    return this.uow.run(principal, async (tx) => {
      const ticket = await this.loadTicket(tx, key);
      const inbound = await this.email.inboundOfTicket(tx, ticket.id);
      const outbound = await this.email.outboundOfTicket(tx, ticket.id);
      return {
        inbound: inbound.map((row) => ({ ...row, raw_s3_key: undefined })),
        outbound: outbound.map((row) => ({ ...row, rendered_s3_key: undefined })),
      };
    });
  }

  rawUrl(principal: Principal, ctx: RequestContext, inboundId: string) {
    return this.uow.run(principal, async (tx) => {
      const row = await this.email.inboundById(tx, inboundId);
      const url = await this.store.presignDownload(row.raw_s3_key, {
        fileName: `${row.message_id.replace(/[<>]/g, '')}.eml`,
        contentType: 'message/rfc822',
      });
      await this.security.write({
        type: 'data.attachment.downloaded',
        outcome: 'success',
        accountId: row.account_id,
        actorKind: 'user',
        actorId: principal.userId,
        actorName: principal.displayName,
        principalKind: principal.kind,
        requestId: ctx.requestId,
        entityKind: 'inbound_message',
        entityId: row.id,
        attrs: { kind: 'raw_email' },
      });
      return { url };
    });
  }

  // Outbound ----------------------------------------------------------------

  /** Outbox handler: public comments by operators, acknowledgements for email and portal tickets, resolution notices. */
  async handleOutbox(row: OutboxRow): Promise<void> {
    if (!['comment.created', 'ticket.created', 'ticket.transitioned'].includes(row.event_type)) return;
    await this.uow.worker([row.account_id], async (tx) => {
      const ticket = await this.tickets.byId(tx, row.aggregate_id).catch(() => undefined);
      if (!ticket || !ticket.requester_contact_id) return;
      const requester = await this.tickets.contactById(tx, ticket.requester_contact_id);
      const account = await this.accounts.byId(tx, ticket.account_id);
      const branding: Branding = {
        accountName: account.name,
        accent: typeof account.branding?.accent === 'string' ? (account.branding.accent as string) : undefined,
      };
      let rendered: Rendered | undefined;
      let kind = '';
      if (row.event_type === 'ticket.created' && (ticket.source === 'email' || ticket.source === 'portal')) {
        kind = 'acknowledgement';
        rendered = acknowledgement({
          key: ticketKey(ticket.number),
          shortDescription: ticket.short_description,
          requesterName: requester.display_name || requester.email,
          branding,
        });
      } else if (row.event_type === 'comment.created' && row.payload.source === 'internal') {
        const comment = await tx.query<{ body: string; author_name: string }>(
          'select body, author_name from acct.comments where id = $1',
          [String(row.payload.comment_id)],
        );
        if (!comment.rows[0]) return;
        kind = 'public_comment';
        rendered = publicComment({
          key: ticketKey(ticket.number),
          shortDescription: ticket.short_description,
          authorName: comment.rows[0].author_name,
          body: comment.rows[0].body,
          branding,
        });
      } else if (
        row.event_type === 'ticket.transitioned' &&
        ticket.resolved_at &&
        row.payload.to &&
        ['resolved', 'fulfilled', 'completed', 'done'].includes(String(row.payload.to))
      ) {
        kind = 'resolved';
        rendered = resolved({
          key: ticketKey(ticket.number),
          shortDescription: ticket.short_description,
          resolutionNotes: ticket.resolution_notes ?? '',
          branding,
        });
      }
      if (!rendered) return;
      if (await this.email.isSuppressed(tx, ticket.account_id, requester.email)) {
        this.logger.warn(`outbound to ${requester.email} suppressed`);
        return;
      }
      await this.sendToRequester(tx, ticket, account.key, requester.email, kind, rendered, Number(row.id));
    });
  }

  private async sendToRequester(
    tx: Tx,
    ticket: TicketRow,
    accountKey: string,
    to: string,
    kind: string,
    rendered: Rendered,
    outboxId: number | null,
  ): Promise<void> {
    const env = loadEnv();
    const identity =
      (await this.email.defaultIdentity(tx, ticket.account_id)) ??
      (await this.email.insertIdentity(
        tx,
        ticket.account_id,
        `${accountKey.toLowerCase()}@${env.MAIL_DOMAIN}`,
        `${accountKey} support`,
        true,
      ));
    let token = ticket.email_token;
    if (!token) {
      token = newEmailToken();
      await tx.query('update acct.tickets set email_token = $2 where id = $1 and email_token is null', [
        ticket.id,
        token,
      ]);
    }
    const replyTo = identity.address.replace('@', `+${token}@`);
    const messageId = `<${randomUUID()}@${env.MAIL_DOMAIN}>`;
    const latest = await this.email.latestThreadMessageId(tx, ticket.id);
    const references = latest ? [...latest.references, latest.id].slice(-20) : [];
    const composer = new MailComposer({
      from: { name: identity.display_name, address: identity.address },
      to,
      replyTo,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageId,
      inReplyTo: latest?.id,
      references,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-XMS-Ticket': ticketKey(ticket.number) },
    });
    const raw = await composer.compile().build();
    const renderedKey = `accounts/${ticket.account_id}/email/outbound/${new Date().toISOString().slice(0, 7).replace('-', '/')}/${randomUUID()}.eml`;
    await this.store.putObject(renderedKey, raw, 'message/rfc822');
    const outbound = await this.email.insertOutbound(tx, {
      account_id: ticket.account_id,
      ticket_id: ticket.id,
      kind,
      template_version: TEMPLATE_VERSION,
      message_id: messageId,
      in_reply_to: latest?.id ?? null,
      references,
      from_identity_id: identity.id,
      from_address: identity.address,
      to_addresses: [to],
      cc_addresses: [],
      subject: rendered.subject,
      rendered_s3_key: renderedKey,
      outbox_id: outboxId === null ? null : String(outboxId),
    });
    if (!outbound) return; // already sent for this outbox row
    await this.email.insertDelivery(tx, ticket.account_id, outbound.id, null, 'queued');
    try {
      const result = await this.transport.send({ from: identity.address, to: [to], raw, messageId });
      await this.email.insertDelivery(tx, ticket.account_id, outbound.id, result.providerMessageId, 'sent');
    } catch (error) {
      await this.email.insertDelivery(tx, ticket.account_id, outbound.id, null, 'failed', {
        error: (error as Error).message,
      });
      throw error;
    }
    await this.audit.account(tx, ticket.account_id, SYSTEM_ACTOR, { correlationId: `outbox:${outboxId}` }, [
      {
        entityKind: 'outbound_message',
        entityId: outbound.id,
        ticketId: ticket.id,
        eventType: 'created',
        newValue: { kind, to: [to], message_id: messageId },
      },
    ]);
  }

  /** SES delivery, bounce and complaint events (through SNS). */
  async applyDeliveryEvent(event: {
    eventType: string;
    mail?: { messageId?: string };
    bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress: string }[] };
    complaint?: { complainedRecipients?: { emailAddress: string }[] };
  }): Promise<{ matched: boolean; state?: string }> {
    const providerId = event.mail?.messageId;
    if (!providerId) return { matched: false };
    // Delivery rows are account-scoped and few; the worker binds every live account for the lookup.
    const accountIds = (
      await this.pools.get('worker').query<{ id: string }>(`select id from op.accounts where status <> 'system'`)
    ).rows.map((row) => row.id);
    return this.uow.worker(accountIds, async (tx) => {
      const delivery = await this.email.deliveryByProviderId(tx, providerId);
      if (!delivery) return { matched: false };
      const type = event.eventType.toLowerCase();
      let state: string | undefined;
      if (type === 'delivery') {
        state = 'delivered';
        await this.email.setDeliveryState(tx, delivery.id, state, {});
      } else if (type === 'bounce') {
        state = 'bounced';
        await this.email.setDeliveryState(tx, delivery.id, state, { bounceType: event.bounce?.bounceType });
        if (event.bounce?.bounceType === 'Permanent') {
          for (const recipient of event.bounce.bouncedRecipients ?? []) {
            await this.email.suppress(tx, delivery.account_id, recipient.emailAddress, 'bounce_hard', delivery.id);
          }
        }
      } else if (type === 'complaint') {
        state = 'complained';
        await this.email.setDeliveryState(tx, delivery.id, state, {});
        for (const recipient of event.complaint?.complainedRecipients ?? []) {
          await this.email.suppress(tx, delivery.account_id, recipient.emailAddress, 'complaint', delivery.id);
        }
      }
      return { matched: true, state };
    });
  }

  private loadTicket(tx: Tx, key: string) {
    const number = key.match(/^CS(\d{7,})$/i) ? String(Number(key.slice(2))) : undefined;
    return number ? this.tickets.byNumber(tx, number) : this.tickets.byId(tx, key);
  }
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => entry.value.map((item) => (item.address ?? '').toLowerCase()).filter(Boolean));
}

function headerAddresses(parsed: ParsedMail, name: string): string[] {
  const value = parsed.headers.get(name);
  if (!value) return [];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((address) => address.toLowerCase());
}

function htmlToText(html: string): string {
  return html
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div class="gmail_quote"[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function badRequest(code: string): BadRequestException {
  return new BadRequestException({ code });
}

export { NotFoundException };
