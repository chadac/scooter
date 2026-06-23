{ lib, python3Packages, ... }:

# Webhooks service (Python/FastAPI). Spawns agent conversations from
# GitHub/GitLab/Jira/Slack threads via the agent-host /agui endpoint.
# See docs/WEBHOOKS.md.

python3Packages.buildPythonApplication {
  pname = "agent-webhooks";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.setuptools ];

  dependencies = with python3Packages; [
    fastapi
    uvicorn
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    pyjwt
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [ "webhooks.app" ];

  meta.description = "Spawn-from-conversation webhooks for kubenix-agent-manager";
}
