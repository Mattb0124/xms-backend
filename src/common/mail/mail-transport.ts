import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'node:crypto';
import type { ObjectStore } from '../storage/object-store.js';

/**
 * Outbound mail transport (Email Intake & Outbound technical 3.2). The
 * service renders a complete MIME message (threading headers included) and
 * hands it here; SES in AWS, a file transport in development (the rendered
 * .eml lands in the object store under `mail/outbound/`), a recording
 * transport in tests.
 */
export interface OutgoingMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly raw: Buffer;
  readonly messageId: string;
}

export interface MailTransport {
  readonly kind: 'ses' | 'file' | 'recording';
  send(mail: OutgoingMail): Promise<{ providerMessageId: string }>;
}

export class SesTransport implements MailTransport {
  readonly kind = 'ses' as const;
  private readonly client: SESv2Client;

  constructor(
    region: string,
    private readonly configurationSet?: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(mail: OutgoingMail): Promise<{ providerMessageId: string }> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: mail.from,
        Destination: { ToAddresses: [...mail.to], CcAddresses: [...(mail.cc ?? [])] },
        Content: { Raw: { Data: mail.raw } },
        ConfigurationSetName: this.configurationSet,
      }),
    );
    return { providerMessageId: result.MessageId ?? mail.messageId };
  }
}

export class FileTransport implements MailTransport {
  readonly kind = 'file' as const;

  constructor(private readonly store: ObjectStore) {}

  async send(mail: OutgoingMail): Promise<{ providerMessageId: string }> {
    const key = `mail/outbound/${new Date().toISOString().slice(0, 10)}/${mail.messageId.replace(/[<>@]/g, '_')}.eml`;
    await this.store.putObject(key, mail.raw, 'message/rfc822');
    return { providerMessageId: `file:${key}` };
  }
}

export class RecordingTransport implements MailTransport {
  readonly kind = 'recording' as const;
  readonly sent: OutgoingMail[] = [];

  async send(mail: OutgoingMail): Promise<{ providerMessageId: string }> {
    this.sent.push(mail);
    return { providerMessageId: `rec:${randomUUID()}` };
  }
}
