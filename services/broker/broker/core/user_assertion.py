"""User-assertion verification, the broker half of the token the conversation router mints
in services/conversation-router/userassertion.go.

The router stamps it on a request only once it has proven the user (a browser session or
an allowlisted asserter such as webhooks), and the agent-host relays it with an approval
answer. An approver SA therefore cannot name an approver the router never proved.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

# Must match services/conversation-router/userassertion.go, pinned by tests/fixtures/user-assertion.json.
USER_ASSERTION_AUDIENCE = "scooter-user-assertion"
USER_ASSERTION_ISSUER = "scooter-router"
USER_ASSERTION_HEADER = "x-scooter-user-assertion"


@dataclass(frozen=True)
class UserAssertion:
    user: str
    email: str | None = None

    def vouches_for(self, approver: object) -> bool:
        """Whether a relayed `approver` (an identity dict or a plain string) names only this user."""
        if isinstance(approver, dict):
            if approver.get("id") != self.user:
                return False
            email = approver.get("email")
            return email is None or (self.email is not None and email.lower() == self.email.lower())
        if isinstance(approver, str):
            name = approver[len("user:"):] if approver.startswith("user:") else approver
            return name == self.user or (self.email is not None and name.lower() == self.email.lower())
        return False


class UserAssertionError(Exception):
    """Verification failed, with a message meant for the broker's log rather than the caller."""


def verify_user_assertion(token: str, secret: str, now: int | None = None) -> UserAssertion:
    """Verify a user assertion against an injectable clock `now`, raising UserAssertionError on any failure."""
    if not secret:
        raise UserAssertionError("no user-assertion secret configured")
    if not token:
        raise UserAssertionError("no user assertion presented")

    import jwt

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            audience=USER_ASSERTION_AUDIENCE,
            issuer=USER_ASSERTION_ISSUER,
            # Expiry is checked below so a frozen test vector verifies against an injected clock.
            options={"require": ["exp", "iat", "sub", "aud", "iss"], "verify_exp": False},
        )
    except jwt.InvalidTokenError as exc:
        raise UserAssertionError(f"invalid user assertion: {exc}") from exc

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        raise UserAssertionError("user assertion has a non-numeric exp")
    if exp <= (now if now is not None else int(time.time())):
        raise UserAssertionError("user assertion has expired")

    user = claims.get("sub")
    if not isinstance(user, str) or not user:
        raise UserAssertionError("user assertion names no user")
    email = claims.get("email")
    return UserAssertion(user=user, email=email if isinstance(email, str) and email else None)
