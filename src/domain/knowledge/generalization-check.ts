/**
 * The identifier checklist (Solution Knowledge Base technical 2.10): a
 * generalized article must not carry the originating account's name,
 * contact names or emails, hostnames from its configuration items, or
 * attachment references. Pure; returns every finding so the curator can
 * fix them all at once.
 */
export interface GeneralizationContext {
  readonly accountNames: readonly string[];
  readonly contactNames: readonly string[];
  readonly contactEmails: readonly string[];
  readonly hostnames: readonly string[];
}

export interface Finding {
  readonly section: string;
  readonly kind: 'account_name' | 'contact_name' | 'email' | 'hostname' | 'attachment' | 'ip_address';
  readonly value: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const ATTACHMENT = /\b(?:attachment|screenshot|see attached|\.(?:png|jpg|jpeg|xlsx|docx|pdf|log))\b/gi;

export function checkGeneralization(sections: Record<string, string>, context: GeneralizationContext): Finding[] {
  const findings: Finding[] = [];
  const names = [...context.accountNames].filter((name) => name.trim().length >= 3);
  const contacts = [...context.contactNames].filter((name) => name.trim().length >= 3);
  const hosts = [...context.hostnames].filter((host) => host.trim().length >= 3);
  for (const [section, text] of Object.entries(sections)) {
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const name of names)
      if (lower.includes(name.toLowerCase())) findings.push({ section, kind: 'account_name', value: name });
    for (const name of contacts)
      if (lower.includes(name.toLowerCase())) findings.push({ section, kind: 'contact_name', value: name });
    for (const host of hosts)
      if (lower.includes(host.toLowerCase())) findings.push({ section, kind: 'hostname', value: host });
    for (const email of text.match(EMAIL) ?? []) {
      // Generic examples are fine; anything that looks like a real mailbox is not.
      if (!/example\.(?:test|com|org)$/i.test(email)) findings.push({ section, kind: 'email', value: email });
    }
    for (const ip of text.match(IP) ?? []) findings.push({ section, kind: 'ip_address', value: ip });
    for (const reference of text.match(ATTACHMENT) ?? [])
      findings.push({ section, kind: 'attachment', value: reference });
  }
  return dedupe(findings);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.section}:${finding.kind}:${finding.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
