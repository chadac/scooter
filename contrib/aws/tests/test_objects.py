"""aws's authz object namespace.

The one assertion here lived in the broker app's test_authz.py, which imported
`aws_account_object` to check the spelling. That coupled the app's authorizer-seam
test to an integration's namespace, and the seam does not know what an AWS account
is — so the helper's coverage came here with the helper (PR #599).

The spelling is not cosmetic. `service.py` passes this object id to
authorizer.check() on approve/deny, and the FGA approver tuples are seeded against
the same id at startup (broker_provider.seed_approver_tuples). If the two ever spell
an account differently the check finds no tuple and, since check() fails CLOSED,
every approval is denied — a deployment that looks configured and approves nothing.
"""

from __future__ import annotations

from scooter_contrib_aws.objects import aws_account_object


def test_object_id_spelling():
    assert aws_account_object("dev") == "aws_account:dev"


def test_seeding_and_checking_agree_on_the_spelling():
    """Both call sites must derive the id the same way — the reason it is a helper
    and not an f-string at each site."""
    alias = "readonly-sandbox"
    assert aws_account_object(alias) == f"aws_account:{alias}"
