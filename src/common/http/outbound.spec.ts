import { describe, expect, it } from 'vitest';
import { MAX_OUTBOUND_BODY_BYTES, OutboundBodyTooLarge, outboundProblem, readCappedText } from './outbound.js';

/**
 * The delivery-time destination guard and the response body cap (security
 * review findings 4, 5 and 17). Registration only sees the literal a person
 * typed; these are the checks that stand between a receiver and the VPC when
 * the call is actually made.
 */
const lookupAs =
  (...addresses: string[]) =>
  async (): Promise<{ address: string; family: number }[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('the delivery-time destination guard', () => {
  it('refuses a public name that resolves to a private address (DNS rebinding)', async () => {
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs('203.0.113.10'))).toBeNull();
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs('127.0.0.1'))).toBe('private_address');
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs('169.254.169.254'))).toBe(
      'private_address',
    );
    // One private answer among several is enough to refuse.
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs('203.0.113.10', '10.0.0.5'))).toBe(
      'private_address',
    );
  });

  it('refuses the whole of fe80::/10, not only fe80 and fe90', async () => {
    for (const address of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1']) {
      expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs(address))).toBe('private_address');
    }
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs('fec0::1'))).toBeNull();
  });

  it('refuses every numeric form of loopback, and any host that is neither a name nor a literal', async () => {
    const never = async (): Promise<{ address: string; family: number }[]> => {
      throw new Error('the guard must refuse these before any lookup');
    };
    // isIP returns 0 for all four of these and getaddrinfo resolves every one
    // to loopback; WHATWG URL normalises them first, so the private ranges do
    // apply. This pins that, because the guard reads URL.hostname and nothing else.
    for (const host of ['2130706433', '0x7f000001', '127.1', '0177.0.0.1', '127.0.0.1']) {
      expect(await outboundProblem(`https://${host}/x`, false, never)).toBe('private_host');
    }
    // A bare label is neither a registered domain nor a literal, so a search
    // domain cannot quietly land the call inside the VPC. Refused before any lookup.
    for (const host of ['intranet', 'snow', 'host_name.example.com']) {
      expect(await outboundProblem(`https://${host}/x`, false, never)).toBe('invalid_host');
    }
    expect(await outboundProblem('https://203.0.113.10/x', false, never)).toBeNull();
  });

  it('refuses a host that does not resolve, and skips the lookup when private destinations are allowed', async () => {
    const failing = async (): Promise<{ address: string; family: number }[]> => {
      throw new Error('ENOTFOUND');
    };
    expect(await outboundProblem('https://nowhere.example.com/x', false, failing)).toBe('unresolved_host');
    expect(await outboundProblem('https://hooks.example.com/x', false, lookupAs())).toBe('unresolved_host');
    expect(await outboundProblem('http://127.0.0.1:9/x', true, failing)).toBeNull();
  });

  it('keeps the registration refusals', async () => {
    expect(await outboundProblem('http://hooks.example.com/x', false, lookupAs('203.0.113.10'))).toBe('not_https');
    expect(await outboundProblem('not a url', false, lookupAs('203.0.113.10'))).toBe('invalid_url');
  });
});

describe('the response body cap', () => {
  const streamed = (chunks: string[], headers: Record<string, string> = {}): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { headers },
    );

  it('reads a body under the cap', async () => {
    expect(await readCappedText(streamed(['{"ok":', 'true}']))).toBe('{"ok":true}');
  });

  it('refuses a declared length over the cap without reading it', async () => {
    await expect(
      readCappedText(streamed(['x'], { 'content-length': String(MAX_OUTBOUND_BODY_BYTES + 1) })),
    ).rejects.toBeInstanceOf(OutboundBodyTooLarge);
  });

  it('refuses a body that exceeds the cap while streaming, whatever it declared', async () => {
    await expect(readCappedText(streamed(['abcdef', 'ghijkl']), 8)).rejects.toBeInstanceOf(OutboundBodyTooLarge);
  });
});
