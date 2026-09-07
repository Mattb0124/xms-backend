import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Amazon SNS message signature verification for the SES event webhook
 * (Security section 2.3: unsigned or unconfigured means reject). The
 * signing certificate URL must be an https URL on an amazonaws host; the
 * certificate fetcher is injected so tests can supply a local key.
 */
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn?: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

const SIGNING_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export function stringToSign(message: SnsMessage): string {
  const fields = SIGNING_FIELDS[message.Type];
  if (!fields) throw new Error(`Unsupported SNS type ${message.Type}`);
  let output = '';
  for (const field of fields) {
    const value = (message as unknown as Record<string, string | undefined>)[field];
    if (value === undefined) continue;
    output += `${field}\n${value}\n`;
  }
  return output;
}

export function isTrustedCertUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(parsed.hostname) &&
      parsed.pathname.endsWith('.pem')
    );
  } catch {
    return false;
  }
}

export async function verifySnsMessage(
  message: SnsMessage,
  fetchCert: (url: string) => Promise<string>,
  options: { trustUrl?: (url: string) => boolean } = {},
): Promise<boolean> {
  const trust = options.trustUrl ?? isTrustedCertUrl;
  if (!trust(message.SigningCertURL)) return false;
  if (!message.Signature || !message.SignatureVersion) return false;
  const algorithm =
    message.SignatureVersion === '2' ? 'RSA-SHA256' : message.SignatureVersion === '1' ? 'RSA-SHA1' : undefined;
  if (!algorithm) return false;
  let pem: string;
  try {
    pem = await fetchCert(message.SigningCertURL);
  } catch {
    return false;
  }
  try {
    const key = createPublicKey(pem);
    return cryptoVerify(
      algorithm,
      Buffer.from(stringToSign(message), 'utf8'),
      key,
      Buffer.from(message.Signature, 'base64'),
    );
  } catch {
    return false;
  }
}
