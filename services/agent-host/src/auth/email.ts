/**
 * Email normalization for identity matching. So the SAME person maps to ONE Scooter
 * user regardless of the cosmetic variations different providers (Slack/GitHub/GitLab/
 * the ingress) hand us for the same mailbox:
 *
 *   - lowercase (Alice@Example.com == alice@example.com — email is case-insensitive
 *     for routing in practice; the local part is technically case-sensitive per RFC
 *     but no real provider treats it so)
 *   - trim surrounding whitespace
 *   - drop a `+tag` sub-address in the local part (alice+work@x.com == alice@x.com —
 *     `+tag` is a universal alias for the same mailbox at every provider that supports
 *     it, and providers that DON'T support it simply never see a `+` here)
 *
 * We deliberately do NOT strip dots: `a.b@` vs `ab@` are the SAME mailbox at Gmail but
 * DIFFERENT people at most other providers, so dot-stripping would wrongly merge two
 * users' identities. Case + trim + `+tag` is safe for every provider.
 *
 * Used on BOTH sides of the id↔email mapping (write + lookup in identityStore), so the
 * webhook's resolved email and the stored identity always agree.
 */

/** Normalize an email for identity matching. Returns "" for a falsy/blank input. A
 *  string without a single "@" is only lowercased + trimmed (not a routable address;
 *  we don't guess a local/domain split). */
export function normalizeEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  const at = trimmed.lastIndexOf("@");
  // No "@" (or "@" at the very start/end) — not a normal addr; just lowercase+trim.
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  // Drop the +tag sub-address: everything from the first "+" in the local part.
  const plus = local.indexOf("+");
  const baseLocal = plus === -1 ? local : local.slice(0, plus);
  // A local part that is ONLY a tag ("+tag@x") has no base — keep the original local
  // rather than producing "@domain" (which would collide across unrelated addresses).
  const finalLocal = baseLocal || local;
  return `${finalLocal}@${domain}`;
}
