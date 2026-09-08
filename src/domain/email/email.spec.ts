import { describe, expect, it } from 'vitest';
import { scoreLoop } from './loop-guard.js';
import { stripReply } from './stripper.js';
import {
  matchThread,
  newEmailToken,
  normaliseMessageId,
  plusTokenOf,
  subjectKeyOf,
  type ThreadLookup,
} from './thread-matcher.js';

const lookup = (overrides: Partial<ThreadLookup> = {}): ThreadLookup => ({
  byPlusToken: async () => undefined,
  byMessageId: async () => undefined,
  byTicketKey: async () => undefined,
  ...overrides,
});

describe('thread matcher', () => {
  it('prefers the plus token, then In-Reply-To, then References, then the subject key', async () => {
    const full = lookup({
      byPlusToken: async (token) => (token === 'abcdefghijk2' ? 't-token' : undefined),
      byMessageId: async (id) => (id === '<out-1@xms>' ? 't-reply' : id === '<out-0@xms>' ? 't-ref' : undefined),
      byTicketKey: async () => ({ ticketId: 't-subject', closedTooLong: false }),
    });
    const headers = {
      recipients: ['brk+abcdefghijk2@mail.xms.test'],
      inReplyTo: '<out-1@xms>',
      references: ['<out-0@xms>'],
      subject: 'Re: [CS0001234] x',
    };
    expect(await matchThread(headers, full)).toEqual({ ticketId: 't-token', matchedBy: 'plus_token' });
    expect(await matchThread({ ...headers, recipients: ['support@mail.xms.test'] }, full)).toEqual({
      ticketId: 't-reply',
      matchedBy: 'in_reply_to',
    });
    expect(await matchThread({ ...headers, recipients: [], inReplyTo: '<other@x>' }, full)).toEqual({
      ticketId: 't-ref',
      matchedBy: 'references',
    });
    expect(await matchThread({ recipients: [], references: [], subject: 'RE: [cs0001234] please help' }, full)).toEqual(
      { ticketId: 't-subject', matchedBy: 'subject_key' },
    );
  });

  it('ignores a subject key on a ticket closed too long and returns no match otherwise', async () => {
    const stale = lookup({ byTicketKey: async () => ({ ticketId: 't', closedTooLong: true }) });
    expect(await matchThread({ recipients: [], references: [], subject: '[CS0000001] old' }, stale)).toBeUndefined();
    expect(await matchThread({ recipients: ['x@y'], references: [], subject: 'hello' }, lookup())).toBeUndefined();
  });

  it('normalises message ids and extracts tokens and keys', () => {
    expect(normaliseMessageId(' abc@x ')).toBe('<abc@x>');
    expect(normaliseMessageId('<abc@x>')).toBe('<abc@x>');
    expect(plusTokenOf(['Brk+ABCDEFGHIJK2@mail.xms.test'])).toBe('abcdefghijk2');
    expect(plusTokenOf(['brk+short@mail.xms.test'])).toBeUndefined();
    expect(subjectKeyOf('Fwd: Re: [cs0001234] boom')).toBe('CS0001234');
    expect(newEmailToken(() => new Uint8Array(12))).toBe('aaaaaaaaaaaa');
    expect(newEmailToken((size) => new Uint8Array(size).fill(31))).toBe('777777777777');
    expect(newEmailToken()).toMatch(/^[a-z2-7]{12}$/);
  });
});

describe('loop guard', () => {
  const base = {
    headers: {},
    subject: 'Help',
    fromAddress: 'pat@client.test',
    references: [],
    ownMessageIds: new Set<string>(),
    ownSenderAddresses: new Set(['support@mail.xms.test']),
    senderCountLast10Minutes: 0,
    sameSubjectCountLast10Minutes: 0,
  };

  it('suppresses auto-submitted, bulk and self-reflected mail', () => {
    expect(scoreLoop({ ...base, headers: { 'auto-submitted': 'auto-replied' } })).toMatchObject({
      suppress: true,
      signals: ['auto_submitted'],
    });
    expect(scoreLoop({ ...base, headers: { 'auto-submitted': 'no' } }).score).toBe(0);
    expect(scoreLoop({ ...base, headers: { precedence: 'bulk' } })).toMatchObject({ suppress: true });
    expect(scoreLoop({ ...base, headers: { 'list-id': '<x.list>' } })).toMatchObject({ suppress: true });
    expect(scoreLoop({ ...base, fromAddress: 'Support@mail.xms.test' })).toMatchObject({
      suppress: true,
      signals: ['self_reflection'],
    });
  });

  it('flags rate and subject bursts and adds an out-of-office subject', () => {
    const rate = scoreLoop({ ...base, senderCountLast10Minutes: 11 });
    expect(rate).toMatchObject({ score: 60, flagged: true, suppress: false });
    const burst = scoreLoop({ ...base, senderCountLast10Minutes: 11, sameSubjectCountLast10Minutes: 5 });
    expect(burst).toMatchObject({ score: 100, suppress: true });
    const ooo = scoreLoop({ ...base, subject: 'Automatic reply: Help' });
    expect(ooo).toMatchObject({ score: 50, flagged: false, suppress: false });
    const reflected = scoreLoop({
      ...base,
      references: ['<a@xms>', '<b@xms>'],
      ownMessageIds: new Set(['<a@xms>', '<b@xms>']),
    });
    expect(reflected.signals).toEqual(['reflected_thread']);
  });
});

describe('reply stripper', () => {
  it('removes Outlook quoted history, a signature and a disclaimer, keeping the reply', () => {
    const body = [
      'Thanks, that fixed it.',
      '',
      'Kind regards,',
      'Pat Client',
      'Head of Finance',
      '',
      'From: XMS Support <support@mail.xms.test>',
      'Sent: Monday, 7 September 2026 09:00',
      'To: Pat Client',
      'Subject: Re: [CS0001234] Cube refresh',
      '',
      'We renewed the certificate.',
      '',
      'This e-mail and any attachments are confidential and intended solely for the use of the individual to whom they are addressed. If you have received this e-mail in error please notify the sender. Any unauthorised use, disclosure or copying is prohibited and may be unlawful. The company accepts no liability for any damage caused by any virus transmitted by this e-mail. Please consider the environment before printing. This message has been scanned for malware by the corporate gateway, which does not guarantee it is free of all defects.',
    ].join('\n');
    const result = stripReply(body);
    expect(result.text).toBe('Thanks, that fixed it.');
    expect(result.removed).toEqual({ quoted: true, signature: true, disclaimer: false });
  });

  it('removes Gmail and Apple Mail quotes and the "Sent from my iPhone" signature', () => {
    expect(
      stripReply(
        'Still failing.\n\nOn Mon, 7 Sep 2026 at 09:00, XMS Support <support@mail.xms.test> wrote:\n> We renewed it',
      ).text,
    ).toBe('Still failing.');
    expect(stripReply('Works now\n\nSent from my iPhone\n\n> On 7 Sep 2026, at 09:00, XMS wrote:\n> hi').text).toBe(
      'Works now',
    );
  });

  it('drops a standalone long disclaimer paragraph but keeps a long real paragraph', () => {
    const disclaimer = 'This message is confidential and intended solely for the addressee. '.repeat(8);
    const real =
      'The nightly load ran for eleven minutes longer than usual and the cube rebuild reported four warnings about missing members in the entity dimension, which we have listed in the attached spreadsheet along with the times. '.repeat(
        3,
      );
    const result = stripReply(`${real}\n\n${disclaimer}`);
    expect(result.text).toBe(real.trim());
    expect(result.removed.disclaimer).toBe(true);
  });
});
