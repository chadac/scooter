"""The row model matches sql/schema.sql, and no code here issues DDL."""

from pathlib import Path

from scooter_broker_lib.testing import assert_no_runtime_ddl, assert_rows_match_schema_sql
from scooter_contrib_ssh import store

ROOT = Path(__file__).resolve().parents[1]


def test_row_models_match_schema_sql():
    assert_rows_match_schema_sql(store._Base, ROOT / "sql" / "schema.sql")


def test_no_runtime_ddl():
    assert_no_runtime_ddl(ROOT / "scooter_contrib_ssh")
