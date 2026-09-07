import { Injectable } from '@nestjs/common';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';

export interface AliasRow {
  id: string;
  account_id: string;
  address: string;
  kind: 'canonical' | 'alias';
  default_ticket_type: string | null;
  state: 'active' | 'disabled_by_admin' | 'disabled_by_loop_guard';
  disabled_reason: string | null;
  disabled_at: string | null;
  created_at: string;
  version: number;
}

export interface InboundRow {
  id: string;
  account_id: string;
  alias_id: string;
  raw_s3_key: string;
  message_id: string;
  in_reply_to: string | null;
  references: string[];
  plus_token: string | null;
  from_address: string;
  from_name: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  received_at: string;
  sender_resolution: string;
  contact_id: string | null;
  user_id: string | null;
  loop_score: number;
  loop_signals: string[];
  disposition: string;
  suppression_reason: string | null;
  matched_by: string | null;
  ticket_id: string | null;
  comment_id: string | null;
  stripped_body_text: string;
  attachment_count: number;
  size_bytes: number;
  created_at: string;
}

export interface OutboundRow {
  id: string;
  account_id: string;
  ticket_id: string | null;
  kind: string;
  template_version: string;
  message_id: string;
  in_reply_to: string | null;
  references: string[];
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  rendered_s3_key: string;
  outbox_id: string | null;
  created_at: string;
}

export interface SenderIdentityRow {
  id: string;
  account_id: string;
  address: string;
  display_name: string;
  is_default: boolean;
  branding: Record<string, unknown>;
}

export interface QuarantineRow {
  id: string;
  account_id: string;
  inbound_message_id: string;
  reason: string;
  state: 'open' | 'decided' | 'expired';
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  resulting_ticket_id: string | null;
  created_at: string;
  version: number;
}

@Injectable()
export class EmailRepository extends RepositoryBase {
  // Aliases -----------------------------------------------------------------

  aliasesOf(tx: Tx, accountId: string): Promise<AliasRow[]> {
    return this.many<AliasRow>(tx, 'select * from acct.inbound_aliases where account_id = $1 order by kind, address', [
      accountId,
    ]);
  }

  aliasById(tx: Tx, id: string): Promise<AliasRow> {
    return this.one<AliasRow>(tx, 'alias', 'select * from acct.inbound_aliases where id = $1', [id]);
  }

  aliasByAddress(tx: Tx, address: string): Promise<AliasRow | undefined> {
    return this.maybeOne<AliasRow>(tx, 'select * from acct.inbound_aliases where address = $1', [address]);
  }

  insertAlias(
    tx: Tx,
    input: { accountId: string; address: string; kind: string; defaultTicketType?: string | null },
  ): Promise<AliasRow> {
    return this.one<AliasRow>(
      tx,
      'alias',
      `insert into acct.inbound_aliases (account_id, address, kind, default_ticket_type, verified_at) values ($1, $2, $3, $4, now()) returning *`,
      [input.accountId, input.address.toLowerCase(), input.kind, input.defaultTicketType ?? null],
    );
  }

  setAliasState(tx: Tx, id: string, state: AliasRow['state'], reason: string | null): Promise<AliasRow> {
    return this.one<AliasRow>(
      tx,
      'alias',
      `update acct.inbound_aliases set state = $2, disabled_reason = $3, disabled_at = case when $2 = 'active' then null else now() end where id = $1 returning *`,
      [id, state, reason],
    );
  }

  /** Operator-scoped resolution before any binding exists (SECURITY DEFINER function from 0008). */
  async accountForAlias(tx: Tx, address: string): Promise<string | undefined> {
    const row = await this.maybeOne<{ id: string | null }>(tx, 'select sys.account_for_alias($1) as id', [
      address.toLowerCase(),
    ]);
    return row?.id ?? undefined;
  }

  // Sender identities -------------------------------------------------------

  defaultIdentity(tx: Tx, accountId: string): Promise<SenderIdentityRow | undefined> {
    return this.maybeOne<SenderIdentityRow>(
      tx,
      'select * from acct.sender_identities where account_id = $1 and is_default order by created_at limit 1',
      [accountId],
    );
  }

  insertIdentity(
    tx: Tx,
    accountId: string,
    address: string,
    displayName: string,
    isDefault: boolean,
  ): Promise<SenderIdentityRow> {
    return this.one<SenderIdentityRow>(
      tx,
      'sender_identity',
      `insert into acct.sender_identities (account_id, address, display_name, is_default, dkim_status) values ($1, $2, $3, $4, 'verified') returning *`,
      [accountId, address.toLowerCase(), displayName, isDefault],
    );
  }

  ownSenderAddresses(tx: Tx, accountId: string): Promise<string[]> {
    return this.many<{ address: string }>(tx, 'select address from acct.sender_identities where account_id = $1', [
      accountId,
    ]).then((rows) => rows.map((row) => row.address.toLowerCase()));
  }

  // Inbound -----------------------------------------------------------------

  insertInbound(tx: Tx, row: Omit<InboundRow, 'id' | 'created_at'>): Promise<InboundRow> {
    return this.one<InboundRow>(
      tx,
      'inbound_message',
      `insert into acct.inbound_messages (account_id, alias_id, raw_s3_key, message_id, in_reply_to, "references", plus_token, from_address, from_name, to_addresses, cc_addresses, subject,
         received_at, sender_resolution, contact_id, user_id, loop_score, loop_signals, disposition, suppression_reason, matched_by, ticket_id, comment_id, stripped_body_text, attachment_count, size_bytes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26) returning *`,
      [
        row.account_id,
        row.alias_id,
        row.raw_s3_key,
        row.message_id,
        row.in_reply_to,
        row.references,
        row.plus_token,
        row.from_address,
        row.from_name,
        row.to_addresses,
        row.cc_addresses,
        row.subject,
        row.received_at,
        row.sender_resolution,
        row.contact_id,
        row.user_id,
        row.loop_score,
        row.loop_signals,
        row.disposition,
        row.suppression_reason,
        row.matched_by,
        row.ticket_id,
        row.comment_id,
        row.stripped_body_text,
        row.attachment_count,
        row.size_bytes,
      ],
    );
  }

  inboundById(tx: Tx, id: string): Promise<InboundRow> {
    return this.one<InboundRow>(tx, 'inbound_message', 'select * from acct.inbound_messages where id = $1', [id]);
  }

  inboundOfTicket(tx: Tx, ticketId: string): Promise<InboundRow[]> {
    return this.many<InboundRow>(tx, 'select * from acct.inbound_messages where ticket_id = $1 order by received_at', [
      ticketId,
    ]);
  }

  async ticketByMessageId(tx: Tx, messageId: string): Promise<string | undefined> {
    const row = await this.maybeOne<{ ticket_id: string | null }>(
      tx,
      `select ticket_id from acct.outbound_messages where message_id = $1 and ticket_id is not null
       union all
       select ticket_id from acct.inbound_messages where message_id = $1 and ticket_id is not null
       limit 1`,
      [messageId],
    );
    return row?.ticket_id ?? undefined;
  }

  async ticketByEmailToken(tx: Tx, token: string): Promise<string | undefined> {
    const row = await this.maybeOne<{ id: string }>(tx, 'select id from acct.tickets where email_token = $1', [token]);
    return row?.id;
  }

  async ticketByKey(tx: Tx, key: string): Promise<{ id: string; state: string; closed_at: string | null } | undefined> {
    return this.maybeOne(tx, 'select id, state, closed_at from acct.tickets where number = $1', [
      String(Number(key.slice(2))),
    ]);
  }

  async senderCounts(
    tx: Tx,
    accountId: string,
    aliasId: string,
    fromAddress: string,
    subject: string,
  ): Promise<{ sender: number; subject: number }> {
    const row = await this.maybeOne<{ sender: number; subject: number }>(
      tx,
      `select count(*)::int as sender,
              count(*) filter (where alias_id = $2 and subject = $4)::int as subject
         from acct.inbound_messages where account_id = $1 and from_address = $3 and received_at > now() - interval '10 minutes'`,
      [accountId, aliasId, fromAddress, subject],
    );
    return row ?? { sender: 0, subject: 0 };
  }

  async suppressionsInWindow(
    tx: Tx,
    accountId: string,
    aliasId: string,
    fromAddress: string,
  ): Promise<{ suppressed: number; flagged: number }> {
    const row = await this.maybeOne<{ suppressed: number; flagged: number }>(
      tx,
      `select count(*) filter (where disposition = 'suppressed')::int as suppressed,
              count(*) filter (where disposition <> 'suppressed' and loop_score >= 60)::int as flagged
         from acct.inbound_messages where account_id = $1 and alias_id = $2 and from_address = $3 and received_at > now() - interval '10 minutes'`,
      [accountId, aliasId, fromAddress],
    );
    return row ?? { suppressed: 0, flagged: 0 };
  }

  ownMessageIds(tx: Tx, ticketId: string): Promise<string[]> {
    return this.many<{ message_id: string }>(tx, 'select message_id from acct.outbound_messages where ticket_id = $1', [
      ticketId,
    ]).then((rows) => rows.map((row) => row.message_id));
  }

  /** The newest message id in the thread (inbound or outbound) for In-Reply-To. */
  async latestThreadMessageId(tx: Tx, ticketId: string): Promise<{ id: string; references: string[] } | undefined> {
    return this.maybeOne(
      tx,
      `select message_id as id, "references" from (
         select message_id, "references", created_at from acct.outbound_messages where ticket_id = $1
         union all
         select message_id, "references", received_at from acct.inbound_messages where ticket_id = $1
       ) t order by created_at desc limit 1`,
      [ticketId],
    );
  }

  // Outbound ----------------------------------------------------------------

  insertOutbound(
    tx: Tx,
    row: Omit<OutboundRow, 'id' | 'created_at'> & { from_identity_id: string | null },
  ): Promise<OutboundRow | undefined> {
    return this.maybeOne<OutboundRow>(
      tx,
      `insert into acct.outbound_messages (account_id, ticket_id, kind, template_version, message_id, in_reply_to, "references", from_identity_id, from_address, to_addresses, cc_addresses, subject, rendered_s3_key, outbox_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       on conflict (outbox_id) where outbox_id is not null do nothing returning *`,
      [
        row.account_id,
        row.ticket_id,
        row.kind,
        row.template_version,
        row.message_id,
        row.in_reply_to,
        row.references,
        row.from_identity_id,
        row.from_address,
        row.to_addresses,
        row.cc_addresses,
        row.subject,
        row.rendered_s3_key,
        row.outbox_id,
      ],
    );
  }

  outboundOfTicket(tx: Tx, ticketId: string): Promise<(OutboundRow & { state: string | null })[]> {
    return this.many(
      tx,
      `select o.*, d.state from acct.outbound_messages o left join acct.outbound_deliveries d on d.outbound_message_id = o.id where o.ticket_id = $1 order by o.created_at`,
      [ticketId],
    );
  }

  async insertDelivery(
    tx: Tx,
    accountId: string,
    outboundId: string,
    providerMessageId: string | null,
    state: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.query(
      `insert into acct.outbound_deliveries (account_id, outbound_message_id, provider_message_id, state, detail) values ($1, $2, $3, $4, $5)
       on conflict (outbound_message_id) do update set provider_message_id = excluded.provider_message_id, state = excluded.state, state_at = now(), detail = excluded.detail, version = acct.outbound_deliveries.version + 1`,
      [accountId, outboundId, providerMessageId, state, JSON.stringify(detail)],
    );
  }

  async deliveryByProviderId(
    tx: Tx,
    providerMessageId: string,
  ): Promise<{ id: string; account_id: string; outbound_message_id: string } | undefined> {
    return this.maybeOne(
      tx,
      'select id, account_id, outbound_message_id from acct.outbound_deliveries where provider_message_id = $1',
      [providerMessageId],
    );
  }

  async setDeliveryState(tx: Tx, id: string, state: string, detail: Record<string, unknown>): Promise<void> {
    await tx.query(
      'update acct.outbound_deliveries set state = $2, state_at = now(), detail = $3, version = version + 1 where id = $1',
      [id, state, JSON.stringify(detail)],
    );
  }

  async isSuppressed(tx: Tx, accountId: string, address: string): Promise<boolean> {
    const row = await this.maybeOne(
      tx,
      'select 1 from acct.suppressed_addresses where account_id = $1 and address = $2 and cleared_at is null',
      [accountId, address.toLowerCase()],
    );
    return Boolean(row);
  }

  async suppress(tx: Tx, accountId: string, address: string, reason: string, deliveryId: string | null): Promise<void> {
    await tx.query(
      'insert into acct.suppressed_addresses (account_id, address, reason, source_delivery_id) values ($1, $2, $3, $4)',
      [accountId, address.toLowerCase(), reason, deliveryId],
    );
  }

  // Quarantine --------------------------------------------------------------

  insertQuarantine(tx: Tx, accountId: string, inboundId: string, reason: string): Promise<QuarantineRow> {
    return this.one<QuarantineRow>(
      tx,
      'quarantine_item',
      'insert into acct.quarantine_items (account_id, inbound_message_id, reason) values ($1, $2, $3) returning *',
      [accountId, inboundId, reason],
    );
  }

  quarantineList(
    tx: Tx,
    accountIds: string[],
    state: string,
  ): Promise<
    (QuarantineRow & {
      from_address: string;
      from_name: string;
      subject: string;
      received_at: string;
      stripped_body_text: string;
    })[]
  > {
    return this.many(
      tx,
      `select q.*, m.from_address, m.from_name, m.subject, m.received_at, m.stripped_body_text
         from acct.quarantine_items q join acct.inbound_messages m on m.id = q.inbound_message_id
        where q.account_id = any ($1::uuid[]) and q.state = $2 order by q.created_at desc limit 200`,
      [accountIds, state],
    );
  }

  quarantineById(tx: Tx, id: string): Promise<QuarantineRow> {
    return this.one<QuarantineRow>(
      tx,
      'quarantine_item',
      'select * from acct.quarantine_items where id = $1 for update',
      [id],
    );
  }

  decideQuarantine(
    tx: Tx,
    id: string,
    version: number,
    decision: string,
    decidedBy: string,
    ticketId: string | null,
  ): Promise<QuarantineRow> {
    return this.updateVersioned<QuarantineRow>(tx, 'quarantine_item', 'acct.quarantine_items', id, version, {
      state: 'decided',
      decision,
      decided_by: decidedBy,
      decided_at: new Date(),
      resulting_ticket_id: ticketId,
    });
  }

  // sys.inbox dedupe (worker role) ------------------------------------------

  async claimInbox(
    tx: Tx,
    externalId: string,
    accountId: string | null,
    payload: Record<string, unknown>,
  ): Promise<string | undefined> {
    const row = await this.maybeOne<{ id: string }>(
      tx,
      `insert into sys.inbox (connector_instance_id, external_id, external_version, account_id, payload) values ('email', $1, '', $2, $3)
       on conflict (connector_instance_id, external_id, external_version) do nothing returning id`,
      [externalId, accountId, JSON.stringify(payload)],
    );
    return row?.id;
  }

  async finishInbox(tx: Tx, id: string, outcome: string, error?: string): Promise<void> {
    await tx.query('update sys.inbox set applied_at = now(), outcome = $2, error = $3 where id = $1', [
      id,
      outcome,
      error ?? null,
    ]);
  }
}
