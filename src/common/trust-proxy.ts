/**
 * How much of `X-Forwarded-For` to believe (Audit & Analytics 5.2, Security
 * & Tenancy section 9). Behind an ALB `req.ip` is the balancer for every
 * request, so the daily-salted IP hash is a constant and every caller shares
 * one rate-limit bucket. Configured rather than assumed: trusting the header
 * with nothing in front would let a caller choose its own key.
 *
 * "1" is a hop count, "true" trusts everything, "false" nothing, and
 * anything else is an address or subnet list Express understands.
 */
export function trustProxyValue(setting: string): boolean | number | string {
  if (/^\d+$/.test(setting)) return Number(setting);
  if (setting === 'true') return true;
  if (setting === 'false') return false;
  return setting;
}
