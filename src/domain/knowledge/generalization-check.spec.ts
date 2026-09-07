import { describe, expect, it } from 'vitest';
import { checkGeneralization } from './generalization-check.js';

const context = {
  accountNames: ['Brookfield', 'Brookfield Asset Management'],
  contactNames: ['Pat Client'],
  contactEmails: ['pat@client.test'],
  hostnames: ['brk-onestream-prd-01', 'reports.brookfield.internal'],
};

describe('generalization check', () => {
  it('finds account names, contacts, hostnames, emails, IPs and attachment references per section', () => {
    const findings = checkGeneralization(
      {
        problem_statement: 'Brookfield users cannot open the consolidation report on brk-onestream-prd-01.',
        steps: 'Ask Pat Client (pat@client.test) to restart the service at 10.0.4.12, see attached screenshot.',
        cause: 'Certificate expired.',
      },
      context,
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        { section: 'problem_statement', kind: 'account_name', value: 'Brookfield' },
        { section: 'problem_statement', kind: 'hostname', value: 'brk-onestream-prd-01' },
        { section: 'steps', kind: 'contact_name', value: 'Pat Client' },
        { section: 'steps', kind: 'email', value: 'pat@client.test' },
        { section: 'steps', kind: 'ip_address', value: '10.0.4.12' },
      ]),
    );
    expect(findings.some((finding) => finding.kind === 'attachment')).toBe(true);
    expect(findings.filter((finding) => finding.section === 'cause')).toEqual([]);
  });

  it('returns nothing for a clean article and ignores example addresses', () => {
    expect(
      checkGeneralization(
        { steps: 'Renew the certificate on the application server; notify support@example.com.' },
        context,
      ),
    ).toEqual([]);
  });

  it('reports each identifier once per section', () => {
    const findings = checkGeneralization({ steps: 'Brookfield, Brookfield, brookfield' }, context);
    expect(findings).toEqual([{ section: 'steps', kind: 'account_name', value: 'Brookfield' }]);
  });
});
