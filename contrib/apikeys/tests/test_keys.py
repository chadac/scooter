"""Keys parse only in their exact shape, and match only their own secret."""

from scooter_contrib_apikeys import keys


def test_a_generated_key_parses_back_and_matches_its_digest():
    new = keys.generate()
    assert new.plaintext.startswith(f"sct_{new.key_id}_")
    key_id, secret = keys.parse(new.plaintext)
    assert key_id == new.key_id
    assert keys.matches(secret, new.digest)
    assert new.digest != secret


def test_keys_are_unique():
    assert len({keys.generate().plaintext for _ in range(100)}) == 100


def test_malformed_keys_do_not_parse():
    good = keys.generate().plaintext
    for bad in ["", "sct_", good[:-1], good + "x", "xyz" + good[3:], good.upper(), f" {good}"]:
        assert keys.parse(bad) is None


def test_another_secret_does_not_match():
    a, b = keys.generate(), keys.generate()
    assert not keys.matches(keys.parse(b.plaintext)[1], a.digest)
