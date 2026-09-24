"""Every `settings.<name>` in the broker must name a declared field.

A pydantic model raises AttributeError for a field it doesn't declare, so a read
of a DELETED setting is not a stale-but-harmless line — it throws, at runtime,
on whatever path reaches it. #584 deleted `sandbox_control_service_accounts`
from BrokerSettings and left the read in core/auth.py, which put an
AttributeError on the authentication path every caller takes.

A unit test of the affected function is the better test and exists
(test_auth_identity.py). This is the cheap net UNDER it: coverage of a given
line is a thing a refactor can quietly remove, and the reads that matter most
live in the few functions tests tend to stub out rather than run.

The allowed names come from the MODEL (model_fields + attributes), not from
parsing config.py — inherited fields and properties are then included by
construction, and the check can't pass vacuously because a scrape silently
matched nothing. Limitation: it matches the NAME `settings`, so a module binding
that name to something other than BrokerSettings would be a false positive.
"""

from __future__ import annotations

import ast
import pathlib

import broker
from broker.config import BrokerSettings

BROKER = pathlib.Path(broker.__file__).resolve().parent


def test_no_read_of_an_undeclared_setting():
    allowed = set(BrokerSettings.model_fields) | set(dir(BrokerSettings))
    assert "token_audience" in allowed and "store_config" in allowed

    dangling = []
    for path in sorted(BROKER.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if (isinstance(node, ast.Attribute)
                    and isinstance(node.value, ast.Name)
                    and node.value.id == "settings"
                    and node.attr not in allowed):
                dangling.append(f"{path.relative_to(BROKER)}:{node.lineno} settings.{node.attr}")

    assert not dangling, (
        "read of a setting BrokerSettings does not declare — pydantic raises "
        "AttributeError, so this throws wherever it runs:\n  " + "\n  ".join(dangling))
