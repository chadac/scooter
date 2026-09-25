"""aws's own authz object namespace.

The OBJECT half of a tuple belongs to the provider — only aws knows that a registry
alias means `aws_account:<alias>`, which is why aws seeds its own approver tuples
rather than the core doing it. The USER half is generic and comes from the surface.
"""

from __future__ import annotations


def aws_account_object(account: str) -> str:
    """The OpenFGA object id for an AWS account (registry alias)."""
    return f"aws_account:{account}"
