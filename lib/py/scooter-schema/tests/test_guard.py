import pytest

from scooter_schema.guard import DATABASES, check_database


def test_check_database_matches():
    for db in DATABASES:
        check_database(db, db)  # no raise


def test_check_database_mismatch_raises():
    with pytest.raises(RuntimeError, match="refusing to run"):
        check_database("broker", "webhooks")
