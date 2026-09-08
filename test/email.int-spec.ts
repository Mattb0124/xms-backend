import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestContextMiddleware } from '../src/common/request-context.middleware.js';
import { MAIL_TRANSPORT } from '../src/common/storage/storage.module.js';
import { RecordingTransport } from '../src/common/mail/mail-transport.js';
import { resetEnvForTests } from '../src/config/env.js';
import { EICAR } from '../src/modules/attachments/attachments.module.js';
import { SesWebhookService } from '../src/modules/email/email.module.js';
import { stringToSign, type SnsMessage } from '../src/modules/email/sns-signature.js';
import { OutboxDispatcher } from '../src/worker/outbox-dispatcher.js';
import { closePools, pools, resetDatabase, urls, withSuperuser } from './kit/db.js';
import { DEV_SECRET, devToken } from './kit/auth.js';
import {
  appleMailReply,
  gmailNewRequest,
  outOfOffice,
  outlookReply,
  serviceNowNotification,
  withAttachment,
} from './kit/email/corpus.js';

/**
 * Email intake and outbound over the real database with the local store
 * and a recording transport (P1.6.3, P1.6.4 done-when; EM-01 to EM-03,
 * EM-07, EM-08): the corpus (Gmail, Outlook, Apple Mail, ServiceNow
 * notification, out-of-office, attachment with EICAR), a reply appends
 * instead of duplicating, an unknown sender lands in Quarantine and becomes
 * a contact and a ticket, a consultant's public reply produces one outbound
 * message threaded under the original, the SES webhook rejects a bad
 * signature and suppresses a hard bounce.
 */
const ADMIN_EMAIL = 'admin@example.test';
const ALIAS = 'brk-support@mail.xms.local';

let app: INestApplication;
let adminToken: string;
let accountId: string;
let transport: RecordingTransport;
let dispatcher: OutboxDispatcher;
const contactEmail = 'pat@client.test';

beforeAll(async () => {
  await resetDatabase();
  const db = urls();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL_APP: db.app,
    DATABASE_URL_PORTAL: db.portal,
    DATABASE_URL_WORKER: db.worker,
    AUTH_DEV_SECRET: DEV_SECRET,
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    STORAGE_KIND: 'local',
    STORAGE_LOCAL_ROOT: mkdtempSync(join(tmpdir(), 'xms-store-')),
    MAIL_TRANSPORT: 'file',
    MAIL_DOMAIN: 'mail.xms.local',
    // Anyone can create an SNS topic and subscribe this endpoint; AWS signs
    // it with its own key, so the topic is the second half of the credential.
    SES_SNS_TOPIC_ARNS: 'arn:aws:sns:us-east-1:1:ses',
  });
  resetEnvForTests();
  const { AppModule } = await import('../src/app.module.js');
  transport = new RecordingTransport();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(transport)
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(requestContextMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  adminToken = await devToken({ sub: 'dev_admin', email: ADMIN_EMAIL, sid: 'sess_admin' });
  await api().post('/v1/bootstrap').set(bearer(adminToken)).expect(201);
  const account = await api()
    .post('/v1/admin/accounts')
    .set(bearer(adminToken))
    .send({ key: 'BRK', name: 'Brookfield' })
    .expect(201);
  accountId = account.body.id;
  await api().post(`/v1/admin/accounts/${accountId}/activate`).set(bearer(adminToken)).expect(201);
  await api()
    .post(`/v1/accounts/${accountId}/contracts`)
    .set(bearer(adminToken))
    .send({ name: 'Retainer', model: 'retainer' })
    .expect(201);
  await api()
    .post(`/v1/admin/accounts/${accountId}/aliases`)
    .set(bearer(adminToken))
    .send({ address: ALIAS, kind: 'canonical' })
    .expect(201);
  // A known contact through a first internal ticket.
  await api()
    .post('/v1/tickets')
    .set(bearer(adminToken))
    .send({
      account_id: accountId,
      type: 'incident',
      short_description: 'Seed',
      requester_email: contactEmail,
      requester_name: 'Pat Client',
    })
    .expect(201);
  dispatcher = new OutboxDispatcher(pools(), 1000, false);
  const { EmailService } = await import('../src/modules/email/email.service.js');
  const email = app.get(EmailService);
  dispatcher.subscribe(
    'email.outbound',
    (type) => ['comment.created', 'ticket.created', 'ticket.transitioned'].includes(type),
    (row) => email.handleOutbox(row),
  );
});

afterAll(async () => {
  await app?.close();
  await closePools();
});

const api = () => request(app.getHttpServer());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const ingest = (raw: Buffer) =>
  api()
    .post('/v1/dev/email/inbound')
    .set(bearer(adminToken))
    .send({ raw: raw.toString('base64'), encoding: 'base64' });

describe('inbound', () => {
  let key: string;
  let ackMessageId: string;

  it('turns a Gmail message from a known contact into a ticket with source email and an acknowledgement threaded from a plus address', async () => {
    const response = await ingest(
      gmailNewRequest(
        { from: contactEmail, fromName: 'Pat Client', to: ALIAS, subject: 'Cube refresh fails again' },
        'The nightly cube refresh failed twice.',
      ),
    ).expect(201);
    expect(response.body).toMatchObject({ disposition: 'created' });
    key = response.body.ticketKey;
    const ticket = await api().get(`/v1/tickets/${key}`).set(bearer(adminToken)).expect(200);
    expect(ticket.body).toMatchObject({
      source: 'email',
      short_description: 'Cube refresh fails again',
      description: 'The nightly cube refresh failed twice.',
      requester: { email: contactEmail },
    });
    expect(ticket.body.sla.response).toBeDefined();
    await dispatcher.tick();
    expect(transport.sent).toHaveLength(1);
    const raw = transport.sent[0].raw.toString();
    expect(raw).toMatch(/^Subject: \[CS\d{7}\] Cube refresh fails again/m);
    expect(raw).toMatch(/^Reply-To: brk\+[a-z2-7]{12}@mail\.xms\.local/m);
    expect(raw).toMatch(/^From: "?BRK support"? <brk@mail\.xms\.local>/m);
    ackMessageId = raw.match(/^Message-ID: (<[^>]+>)/m)![1];
    const thread = await api().get(`/v1/tickets/${key}/email`).set(bearer(adminToken)).expect(200);
    expect(thread.body.inbound).toHaveLength(1);
    expect(thread.body.outbound[0]).toMatchObject({ kind: 'acknowledgement', state: 'sent', message_id: ackMessageId });
  });

  it('appends an Outlook reply (In-Reply-To) as a stripped public comment instead of a new ticket', async () => {
    const response = await ingest(
      outlookReply(
        { from: contactEmail, to: ALIAS, subject: `RE: [${key}] Cube refresh fails again`, inReplyTo: ackMessageId },
        'Still failing this morning, log attached below.',
      ),
    ).expect(201);
    expect(response.body).toMatchObject({ disposition: 'appended', ticketKey: key });
    const comments = await api().get(`/v1/tickets/${key}/comments`).set(bearer(adminToken)).expect(200);
    expect(comments.body).toHaveLength(1);
    expect(comments.body[0]).toMatchObject({
      body: 'Still failing this morning, log attached below.',
      source: 'portal',
      author_kind: 'portal_user',
    });
    const inbound = await withSuperuser((client) =>
      client.query(`select matched_by, disposition from acct.inbound_messages order by received_at`),
    );
    expect(inbound.rows[1]).toEqual({ matched_by: 'in_reply_to', disposition: 'appended' });
  });

  it('matches an Apple Mail reply through the References chain and the subject key as fallbacks', async () => {
    const byReferences = await ingest(
      appleMailReply(
        { from: contactEmail, to: ALIAS, subject: 'Re: something else', references: ['<unrelated@x>', ackMessageId] },
        'Works now, thanks.',
      ),
    ).expect(201);
    expect(byReferences.body).toMatchObject({ disposition: 'appended', ticketKey: key });
    const bySubject = await ingest(
      gmailNewRequest(
        { from: contactEmail, to: ALIAS, subject: `Fwd: [${key}] update` },
        'Forwarding the vendor note.',
      ),
    ).expect(201);
    expect(bySubject.body).toMatchObject({ disposition: 'appended', ticketKey: key });
    const inbound = await withSuperuser((client) =>
      client.query(`select matched_by from acct.inbound_messages where ticket_id is not null order by received_at`),
    );
    expect(inbound.rows.map((row) => row.matched_by)).toEqual([null, 'in_reply_to', 'references', 'subject_key']);
  });

  it('matches a reply to the plus address even without headers, and drops a duplicate delivery', async () => {
    const token = (
      await withSuperuser((client) =>
        client.query(`select email_token from acct.tickets where number = $1`, [String(Number(key.slice(2)))]),
      )
    ).rows[0].email_token as string;
    const messageId = `<plus-${Date.now()}@client.test>`;
    const first = await ingest(
      gmailNewRequest(
        { from: contactEmail, to: ALIAS.replace('@', `+${token}@`), subject: 'no subject clue', messageId },
        'Plus reply',
      ),
    ).expect(201);
    expect(first.body).toMatchObject({ disposition: 'appended', ticketKey: key });
    const again = await ingest(
      gmailNewRequest(
        { from: contactEmail, to: ALIAS.replace('@', `+${token}@`), subject: 'no subject clue', messageId },
        'Plus reply',
      ),
    ).expect(201);
    expect(again.body.disposition).toBe('duplicate');
  });

  it('suppresses a ServiceNow notification and an out-of-office reply, keeping the evidence', async () => {
    const bulk = await ingest(
      serviceNowNotification({ from: 'noreply@servicenow.test', to: ALIAS, subject: 'INC0012345 updated' }),
    ).expect(201);
    expect(bulk.body).toMatchObject({ disposition: 'suppressed', reason: 'auto_submitted' });
    const ooo = await ingest(
      outOfOffice({ from: contactEmail, to: ALIAS, subject: `[${key}] Cube refresh fails again` }),
    ).expect(201);
    expect(ooo.body.disposition).toBe('suppressed');
    const comments = await api().get(`/v1/tickets/${key}/comments`).set(bearer(adminToken)).expect(200);
    expect(comments.body.map((comment: { body: string }) => comment.body)).not.toContain(
      'I am out of the office until Monday.',
    );
    const rows = await withSuperuser((client) =>
      client.query(
        `select loop_score, loop_signals from acct.inbound_messages where disposition = 'suppressed' order by received_at`,
      ),
    );
    expect(rows.rows[0].loop_score).toBeGreaterThanOrEqual(100);
    expect(rows.rows[1].loop_signals).toEqual(expect.arrayContaining(['auto_submitted', 'auto_reply_subject']));
  });

  it('rejects mail to an unknown alias without storing any account row', async () => {
    const response = await ingest(
      gmailNewRequest({ from: contactEmail, to: 'nobody@mail.xms.local', subject: 'lost' }, 'hello'),
    ).expect(201);
    expect(response.body).toEqual({ disposition: 'rejected', reason: 'no_alias' });
    const inbox = await withSuperuser((client) =>
      client.query(`select outcome, error from sys.inbox where account_id is null`),
    );
    expect(inbox.rows).toEqual([{ outcome: 'failed', error: 'no alias' }]);
  });
});

describe('quarantine', () => {
  it('holds an unknown sender, then one decision creates the contact and the ticket', async () => {
    const response = await ingest(
      gmailNewRequest(
        { from: 'newperson@client.test', fromName: 'New Person', to: ALIAS, subject: 'Access request' },
        'Please grant me access to the planning cube.',
      ),
    ).expect(201);
    expect(response.body).toMatchObject({ disposition: 'quarantined', reason: 'unknown_sender' });
    const open = await api().get('/v1/quarantine').set(bearer(adminToken)).expect(200);
    expect(open.body).toHaveLength(1);
    expect(open.body[0]).toMatchObject({
      reason: 'unknown_sender',
      from_address: 'newperson@client.test',
      subject: 'Access request',
    });
    const decided = await api()
      .post(`/v1/quarantine/${open.body[0].id}/decide`)
      .set(bearer(adminToken))
      .send({ decision: 'create_contact_and_ticket' })
      .expect(201);
    expect(decided.body).toMatchObject({ state: 'decided', decision: 'create_contact_and_ticket' });
    expect(decided.body.ticket_key).toMatch(/^CS\d{7}$/);
    const ticket = await api().get(`/v1/tickets/${decided.body.ticket_key}`).set(bearer(adminToken)).expect(200);
    expect(ticket.body).toMatchObject({
      source: 'email',
      requester: { email: 'newperson@client.test', display_name: 'New Person' },
    });
    const next = await ingest(
      gmailNewRequest({ from: 'newperson@client.test', to: ALIAS, subject: 'Another one' }, 'Now known.'),
    ).expect(201);
    expect(next.body.disposition).toBe('created');
    await api()
      .post(`/v1/quarantine/${open.body[0].id}/decide`)
      .set(bearer(adminToken))
      .send({ decision: 'discard' })
      .expect(409);
  });
});

describe('attachments by email', () => {
  it('stores a clean attachment as public and quarantines EICAR with a placeholder row and a security event', async () => {
    const clean = await ingest(
      withAttachment({ from: contactEmail, to: ALIAS, subject: 'Log file' }, 'See the log.', {
        name: 'job.log',
        contentType: 'text/plain',
        content: Buffer.from('all fine\n'),
      }),
    ).expect(201);
    const cleanList = await api()
      .get(`/v1/tickets/${clean.body.ticketKey}/attachments`)
      .set(bearer(adminToken))
      .expect(200);
    expect(cleanList.body).toHaveLength(1);
    expect(cleanList.body[0]).toMatchObject({
      file_name: 'job.log',
      scan_state: 'clean',
      origin: 'email',
      visibility: 'public',
    });
    const download = await api()
      .get(`/v1/attachments/${cleanList.body[0].id}/download`)
      .set(bearer(adminToken))
      .expect(200);
    expect(download.body.url).toContain('/v1/storage/download?');
    const fetched = await request(app.getHttpServer())
      .get(download.body.url.replace(/^https?:\/\/[^/]+/, ''))
      .expect(200);
    expect(fetched.text).toBe('all fine\n');

    const bad = await ingest(
      withAttachment({ from: contactEmail, to: ALIAS, subject: 'Virus' }, 'Here is the file.', {
        name: 'invoice.txt',
        contentType: 'text/plain',
        content: Buffer.from(EICAR),
      }),
    ).expect(201);
    const badList = await api()
      .get(`/v1/tickets/${bad.body.ticketKey}/attachments`)
      .set(bearer(adminToken))
      .expect(200);
    expect(badList.body[0]).toMatchObject({ scan_state: 'quarantined' });
    expect(badList.body[0].s3_key).toMatch(/^quarantine\//);
    const refused = await api()
      .get(`/v1/attachments/${badList.body[0].id}/download`)
      .set(bearer(adminToken))
      .expect(403);
    expect(refused.body.code).toBe('quarantined');
    const events = await withSuperuser((client) =>
      client.query(
        `select event_type, outcome from sys.security_events where event_type in ('data.attachment.quarantined', 'data.attachment.downloaded') order by occurred_at`,
      ),
    );
    expect(events.rows).toEqual([
      { event_type: 'data.attachment.downloaded', outcome: 'success' },
      { event_type: 'data.attachment.quarantined', outcome: 'withheld' },
      { event_type: 'data.attachment.downloaded', outcome: 'denied' },
    ]);
    const unsupported = await ingest(
      withAttachment({ from: contactEmail, to: ALIAS, subject: 'Exe' }, 'x', {
        name: 'tool.exe',
        contentType: 'application/octet-stream',
        content: Buffer.from('MZ'),
      }),
    ).expect(201);
    const none = await api()
      .get(`/v1/tickets/${unsupported.body.ticketKey}/attachments`)
      .set(bearer(adminToken))
      .expect(200);
    expect(none.body).toEqual([]);
  });
});

describe('outbound', () => {
  it('sends one threaded email for a consultant reply and one for the resolution, never for a work note', async () => {
    await dispatcher.tick();
    transport.sent.length = 0;
    const created = await ingest(
      gmailNewRequest({ from: contactEmail, to: ALIAS, subject: 'Threading check' }, 'Please advise.'),
    ).expect(201);
    const key = created.body.ticketKey;
    await dispatcher.tick();
    const inboundId = (
      await withSuperuser((client) =>
        client.query(
          `select message_id from acct.inbound_messages where ticket_id = (select id from acct.tickets where number = $1)`,
          [String(Number(key.slice(2)))],
        ),
      )
    ).rows[0].message_id as string;
    await api()
      .post(`/v1/tickets/${key}/work-notes`)
      .set(bearer(adminToken))
      .send({ body: 'Internal only' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${key}/comments`)
      .set(bearer(adminToken))
      .send({ body: 'Renewing the certificate now.' })
      .expect(201);
    await dispatcher.tick();
    expect(transport.sent).toHaveLength(2);
    const reply = transport.sent[1].raw.toString();
    expect(reply).toMatch(/^Subject: Re: \[CS\d{7}\] Threading check/m);
    expect(reply).toContain('Renewing the certificate now.');
    expect(reply).not.toContain('Internal only');
    const ackId = transport.sent[0].raw.toString().match(/^Message-ID: (<[^>]+>)/m)![1];
    expect(reply).toMatch(new RegExp(`^In-Reply-To: ${ackId.replace(/[<>.]/g, (c) => `\\${c}`)}`, 'm'));
    expect(reply).toContain(inboundId);
    const ticket = await api().get(`/v1/tickets/${key}`).set(bearer(adminToken)).expect(200);
    await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(adminToken))
      .send({ version: ticket.body.version, to: 'in_progress' })
      .expect(201);
    await api()
      .post(`/v1/tickets/${key}/transitions`)
      .set(bearer(adminToken))
      .send({
        version: ticket.body.version + 1,
        to: 'resolved',
        resolution: {
          code: 'fixed',
          notes: 'Certificate renewed',
          solution_candidate: true,
          time_exemption_reason: 'x',
        },
      })
      .expect(201);
    await dispatcher.tick();
    expect(transport.sent).toHaveLength(3);
    expect(transport.sent[2].raw.toString()).toContain('has been resolved');
    // Redelivery of the same outbox rows never sends twice.
    await withSuperuser((client) =>
      client.query(`update sys.outbox set dispatched_at = null where event_type in ('comment.created')`),
    );
    await dispatcher.tick();
    expect(transport.sent).toHaveLength(3);
  });
});

describe('SES webhook', () => {
  it('rejects an unsigned message with a security event and suppresses a permanent bounce when signed', async () => {
    await api()
      .post('/v1/webhooks/ses')
      .send({
        Type: 'Notification',
        Message: '{}',
        SignatureVersion: '1',
        Signature: 'x',
        SigningCertURL: 'https://evil.test/cert.pem',
        MessageId: '1',
        Timestamp: 'now',
      })
      .expect(401);
    const bad = await withSuperuser((client) =>
      client.query(
        `select count(*)::int as n from sys.security_events where event_type = 'abuse.webhook.bad_signature'`,
      ),
    );
    expect(bad.rows[0].n).toBe(1);

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const webhook = app.get(SesWebhookService);
    webhook.fetchCert = async () => publicKey.export({ type: 'spki', format: 'pem' }).toString();
    webhook.trustUrl = (url) => url === 'https://sns.us-east-1.amazonaws.com/test.pem';
    const providerId = (
      await withSuperuser((client) =>
        client.query(
          `select provider_message_id from acct.outbound_deliveries where provider_message_id is not null limit 1`,
        ),
      )
    ).rows[0].provider_message_id as string;
    const message: SnsMessage = {
      Type: 'Notification',
      MessageId: 'm-1',
      TopicArn: 'arn:aws:sns:us-east-1:1:ses',
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: providerId },
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: contactEmail }] },
      }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1',
      Signature: '',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/test.pem',
    };
    message.Signature = cryptoSign('RSA-SHA1', Buffer.from(stringToSign(message)), privateKey).toString('base64');
    const applied = await api().post('/v1/webhooks/ses').send(message).expect(201);
    expect(applied.body).toMatchObject({ ok: true, matched: true, state: 'bounced' });
    const delivery = await withSuperuser((client) =>
      client.query(`select state from acct.outbound_deliveries where provider_message_id = $1`, [providerId]),
    );
    expect(delivery.rows[0].state).toBe('bounced');
    const suppressed = await withSuperuser((client) =>
      client.query(`select reason from acct.suppressed_addresses where address = $1`, [contactEmail]),
    );
    expect(suppressed.rows).toEqual([{ reason: 'bounce_hard' }]);
    // Tampered payload fails.
    await api()
      .post('/v1/webhooks/ses')
      .send({ ...message, Message: message.Message.replace('Permanent', 'Transient') })
      .expect(401);

    // A correctly signed message from someone else's topic is refused: the
    // signature only proves AWS sent it, never that XMS asked for it.
    const foreign: SnsMessage = { ...message, MessageId: 'm-2', TopicArn: 'arn:aws:sns:us-east-1:999:attacker' };
    foreign.Signature = cryptoSign('RSA-SHA1', Buffer.from(stringToSign(foreign)), privateKey).toString('base64');
    const refused = await api().post('/v1/webhooks/ses').send(foreign).expect(401);
    expect(refused.body.code).toBe('unknown_topic');
    const unknownTopic = await withSuperuser((client) =>
      client.query(`select count(*)::int as n from sys.security_events where attrs->>'reason' = 'unknown_topic'`),
    );
    expect(unknownTopic.rows[0].n).toBe(1);
  });
});
