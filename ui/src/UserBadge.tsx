/**
 * The signed-in user, shown top-right in the header. Sourced from /whoami (the
 * trusted ingress identity) via the session store. Renders NOTHING when the
 * caller is anonymous — i.e. auth is off / no identity header (dev) — so the
 * badge only appears when there's a real identity to show.
 */

import { FiUser } from "react-icons/fi";

import { useCurrentUser } from "./sessions.js";

export interface UserIdentity {
  id: string;
  email: string | null;
  anonymous: boolean;
}

/** Pure presentational badge — takes the identity as props (testable without the
 *  store). Returns null when anonymous / not-yet-loaded. */
export function UserBadgeView({ user }: Readonly<{ user: UserIdentity }>) {
  if (user.anonymous || (!user.email && !user.id)) return null;
  const label = user.email || user.id;
  return (
    <span
      data-testid="user-badge"
      className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground"
      title={user.email ? `${user.email} (${user.id})` : user.id}
    >
      <FiUser className="shrink-0" aria-hidden />
      <span className="max-w-[16rem] truncate">{label}</span>
    </span>
  );
}

/** Store-connected badge for the header. */
export function UserBadge() {
  return <UserBadgeView user={useCurrentUser()} />;
}
