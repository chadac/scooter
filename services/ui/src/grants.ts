/**
 * Standing grants as the agent-host lists them (GET /conversations/:id/grants): the
 * wire shape, the Active/Inactive split and the wording of when a grant ends.
 */

export interface GrantVerb {
  verb: "extend" | "pin" | "revive" | "revoke" | string;
  label: string;
  presets_minutes: number[];
  /** Whether this viewer may use it; the broker enforces it regardless. */
  allowed?: boolean;
}

export interface Grant {
  contrib: string;
  id: string;
  title: string;
  scope: string[];
  status: "active" | "expired" | "revoked";
  granted_by: string;
  granted_at: number;
  /** Epoch ms; null lasts until revoked. */
  expires_at: number | null;
  verbs: GrantVerb[];
  parent_id?: string | null;
  ended_at?: number | null;
  ended_by?: string | null;
}

/** Active grants soonest-ending first (indefinite last), inactive ones newest first. */
export function splitGrants(grants: Grant[], now: number): { active: Grant[]; inactive: Grant[] } {
  // Past its end counts as inactive before the next poll.
  const live = (g: Grant) => g.status === "active" && (g.expires_at === null || g.expires_at > now);
  const end = (g: Grant) => g.expires_at ?? Number.POSITIVE_INFINITY;
  const ended = (g: Grant) => g.ended_at ?? g.expires_at ?? g.granted_at;
  return {
    active: grants.filter(live).sort((a, b) => end(a) - end(b)),
    inactive: grants.filter((g) => !live(g)).sort((a, b) => ended(b) - ended(a)),
  };
}

/** "45m", "3h 5m", "2d 4h": the two largest units. */
export function formatSpan(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A preset as a button label: "+30m", "+8h", "+1d". */
export function formatPreset(minutes: number, sign = "+"): string {
  return sign + formatSpan(minutes * 60_000);
}

/** When the grant ends, or ended, and why. */
export function grantStatusLine(g: Grant, now: number): string {
  if (g.status === "active" && g.expires_at === null) return "Indefinite";
  if (g.status === "active" && g.expires_at !== null && g.expires_at > now) {
    return `Expires in ${formatSpan(g.expires_at - now)}`;
  }
  if (g.status === "revoked") {
    const by = g.ended_by ? ` by ${g.ended_by}` : "";
    return g.ended_at ? `Revoked${by} ${formatSpan(now - g.ended_at)} ago` : `Revoked${by}`;
  }
  return g.expires_at !== null ? `Expired ${formatSpan(now - g.expires_at)} ago` : "Expired";
}
