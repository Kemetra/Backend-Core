/**
 * platform-audit.mask.ts — `actor_label` disclosure rule for
 * `listPlatformAuditEvents` (RT-431 decision D5, constitution XIV).
 *
 * Sign-in rows store an email in `actor_label`. A label containing `@` is
 * returned as the first Unicode code point before the LAST `@` (none when
 * that part is empty), `***`, and everything from the last `@`:
 * `alice@example.com` -> `a***@example.com`, `@example.com` ->
 * `***@example.com`. Any other label is returned as stored.
 */
export function maskActorLabel(label: string | null): string | null {
  if (label === null) return null;
  const at = label.lastIndexOf("@");
  if (at < 0) return label;
  // Iterating a string yields code points, so an emoji stays whole.
  const [first = ""] = label.slice(0, at);
  return `${first}***${label.slice(at)}`;
}
