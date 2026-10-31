/**
 * The signed-in user, shown top-right in the header, sourced from /whoami via the
 * session store. Renders nothing when the caller is anonymous, so the badge only
 * appears when there is a real identity to show.
 */

import { User } from "@/icons";

import { useCurrentUser } from "./sessions.js";

export interface UserIdentity {
  id: string;
  email: string | null;
  anonymous: boolean;
}

/** Pure presentational badge; returns null when anonymous or not yet loaded. */
export function UserBadgeView({ user }: Readonly<{ user: UserIdentity }>) {
  if (user.anonymous || (!user.email && !user.id)) return null;
  const label = user.email || user.id;
  return (
    <span
      data-testid="user-badge"
      className="flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs text-muted-foreground"
      title={user.email ? `${user.email} (${user.id})` : user.id}
    >
      <User className="size-3.5 shrink-0" aria-hidden />
      <span className="max-w-[16rem] truncate">{label}</span>
    </span>
  );
}

/** Store-connected badge for the header. */
export function UserBadge() {
  return <UserBadgeView user={useCurrentUser()} />;
}
