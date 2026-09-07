/**
 * Outbound templates (Email Intake & Outbound technical 3.2, Security
 * section 5). Every template is a function of a client-visible view model
 * type; a work note, a rate or an assignee cannot be referenced because
 * no view model carries them. Plain HTML with the account branding
 * accent; MJML is a month-2 refinement.
 */
export const TEMPLATE_VERSION = 'v1';

export interface Branding {
  readonly accountName: string;
  readonly accent?: string;
  readonly footerText?: string;
}

export interface AcknowledgementView {
  readonly key: string;
  readonly shortDescription: string;
  readonly requesterName: string;
  readonly branding: Branding;
}

export interface PublicCommentView {
  readonly key: string;
  readonly shortDescription: string;
  readonly authorName: string;
  readonly body: string;
  readonly branding: Branding;
}

export interface ResolvedView {
  readonly key: string;
  readonly shortDescription: string;
  readonly resolutionNotes: string;
  readonly branding: Branding;
}

export interface Rendered {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

function layout(branding: Branding, title: string, bodyHtml: string): string {
  const accent = /^#[0-9a-f]{6}$/i.test(branding.accent ?? '') ? branding.accent! : '#10193a';
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:6px">
<tr><td style="background:${accent};color:#ffffff;padding:14px 20px;font-size:14px;font-weight:600">${escape(branding.accountName)} support</td></tr>
<tr><td style="padding:20px;font-size:14px;line-height:1.5"><h1 style="font-size:16px;margin:0 0 12px">${escape(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:12px 20px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0">Reply to this email to add to the request. ${escape(branding.footerText ?? '')}</td></tr>
</table></td></tr></table></body></html>`;
}

export function acknowledgement(view: AcknowledgementView): Rendered {
  const subject = `[${view.key}] ${view.shortDescription}`;
  const text = `Hello ${view.requesterName},\n\nWe have received your request and logged it as ${view.key}: ${view.shortDescription}.\n\nReply to this email to add information.\n`;
  const html = layout(
    view.branding,
    `We have received your request`,
    `<p>Hello ${escape(view.requesterName)},</p><p>Your request has been logged as <strong>${escape(view.key)}</strong>: ${escape(view.shortDescription)}.</p><p>Reply to this email to add information.</p>`,
  );
  return { subject, text, html };
}

export function publicComment(view: PublicCommentView): Rendered {
  const subject = `Re: [${view.key}] ${view.shortDescription}`;
  const text = `${view.authorName} wrote on ${view.key}:\n\n${view.body}\n`;
  const html = layout(
    view.branding,
    `${view.authorName} replied on ${view.key}`,
    `<div style="white-space:pre-wrap">${escape(view.body)}</div>`,
  );
  return { subject, text, html };
}

export function resolved(view: ResolvedView): Rendered {
  const subject = `Re: [${view.key}] ${view.shortDescription}`;
  const text = `${view.key} has been resolved.\n\n${view.resolutionNotes}\n\nIf the problem persists, reply to this email to reopen the request.\n`;
  const html = layout(
    view.branding,
    `${view.key} has been resolved`,
    `<div style="white-space:pre-wrap">${escape(view.resolutionNotes)}</div><p>If the problem persists, reply to this email to reopen the request.</p>`,
  );
  return { subject, text, html };
}

export function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}
