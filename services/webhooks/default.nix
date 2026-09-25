{ lib, python3Packages, scooterSchema, scooterLib, scooterWebhooksLib, contribs ? [ ], ... }:

# Webhooks service (Python/FastAPI). Spawns agent conversations from
# GitHub/GitLab/Jira/Slack threads via the agent-host /agui endpoint.
# See docs/WEBHOOKS.md.
#
# `contribs`: out-of-tree handler packages injected into the image. Each is a
# normal Python dependency, so its dist-info lands on the app's path and the
# handler registry discovers it via the `scooter_webhooks.handlers` entry point
# at startup (see scooter_webhooks_lib/registry.py). Defaults to none — the flake passes the
# webhooks-targeted subset from ./contrib.

python3Packages.buildPythonApplication {
  pname = "agent-webhooks";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    websockets  # WS server (FastAPI) + client (the claude-bridge proxy to the agent-host)
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    asyncpg
    scooterSchema  # generated SQLAlchemy models for the webhooks DB (lib/py/scooter-schema)
    scooterLib     # shared structured-logging convention (lib/py/scooter-lib)
    scooterWebhooksLib # the extension surface a handler composes (lib/py/scooter-webhooks-lib)
  ] ++ contribs;

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [ "webhooks.app" ];

  meta.description = "Spawn-from-conversation webhooks for kubenix-agent-manager";
}
