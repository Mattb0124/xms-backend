/**
 * The email corpus (Email Intake & Outbound technical 8): messages built the
 * way real clients build them, parameterised by the addresses and message
 * ids a test controls. Each shape names the client it imitates.
 */
export interface MessageInput {
  readonly from: string;
  readonly fromName?: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string[];
  readonly headers?: Record<string, string>;
}

let counter = 0;
const nextId = (): string => `<corpus-${Date.now()}-${(counter += 1)}@client.test>`;

function envelope(input: MessageInput, body: string, extraHeaders = ''): Buffer {
  const lines = [
    `From: ${input.fromName ? `"${input.fromName}" <${input.from}>` : input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${input.messageId ?? nextId()}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : '',
    input.references?.length ? `References: ${input.references.join(' ')}` : '',
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    extraHeaders,
    'MIME-Version: 1.0',
  ].filter(Boolean);
  return Buffer.from(`${lines.join('\r\n')}\r\n${body}`, 'utf8');
}

/** A plain new request from Gmail (text/plain only). */
export function gmailNewRequest(input: MessageInput, text: string): Buffer {
  return envelope(
    input,
    ['Content-Type: text/plain; charset="UTF-8"', '', text, '', '-- ', 'Pat Client', 'Head of Finance'].join('\r\n'),
  );
}

/** An Outlook reply with quoted history and a corporate disclaimer. */
export function outlookReply(input: MessageInput, reply: string): Buffer {
  const body = [
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    reply,
    '',
    'Kind regards,',
    'Pat Client',
    '',
    'From: XMS Support <brk@mail.xms.local>',
    'Sent: Monday, 7 September 2026 09:00',
    'To: Pat Client <pat@client.test>',
    'Subject: Re: [CS0001001] Cube refresh fails',
    '',
    'We renewed the certificate.',
    '',
    'This e-mail and any attachments are confidential and intended solely for the use of the individual to whom they are addressed. If you have received this e-mail in error please notify the sender immediately. Any unauthorised use, disclosure or copying is prohibited and may be unlawful. The company accepts no liability for damage caused by any virus transmitted by this e-mail. Please consider the environment before printing this message.',
  ].join('\r\n');
  return envelope(input, body);
}

/** Apple Mail reply: HTML plus text alternative, quote in a blockquote, References chain. */
export function appleMailReply(input: MessageInput, reply: string): Buffer {
  const boundary = 'Apple-Mail=_ABC123';
  const body = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    reply,
    '',
    'Sent from my iPhone',
    '',
    '> On 7 Sep 2026, at 09:00, XMS Support <brk@mail.xms.local> wrote:',
    '> ',
    '> We renewed the certificate.',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    `<html><body><div>${reply}</div><div><br></div><div>Sent from my iPhone</div><blockquote type="cite"><div>We renewed the certificate.</div></blockquote></body></html>`,
    `--${boundary}--`,
  ].join('\r\n');
  return envelope(input, body);
}

/** A ServiceNow style notification (bulk precedence, auto-submitted). */
export function serviceNowNotification(input: MessageInput): Buffer {
  return envelope(
    { ...input, headers: { 'Auto-Submitted': 'auto-generated', Precedence: 'bulk', ...(input.headers ?? {}) } },
    ['Content-Type: text/plain; charset="UTF-8"', '', 'INC0012345 has been updated.'].join('\r\n'),
  );
}

/** An out-of-office auto reply. */
export function outOfOffice(input: MessageInput): Buffer {
  return envelope(
    {
      ...input,
      subject: `Automatic reply: ${input.subject}`,
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', ...(input.headers ?? {}) },
    },
    ['Content-Type: text/plain; charset="UTF-8"', '', 'I am out of the office until Monday.'].join('\r\n'),
  );
}

/** A new request carrying a small attachment (and optionally the EICAR test file). */
export function withAttachment(
  input: MessageInput,
  text: string,
  attachment: { name: string; contentType: string; content: Buffer },
): Buffer {
  const boundary = 'XmsMixed_0001';
  const body = [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attachment.content.toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');
  return envelope(input, body);
}
