"""Smoke test: the package imports. Real coverage lands with the module moves
(the boundary sign-off on the PR); this keeps the skeleton build honest so the
package isn't shipped broken.
"""


def test_importable():
    import scooter_broker_lib

    assert scooter_broker_lib is not None
