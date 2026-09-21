{ lib, python3Packages, scooterSchema, contribs ? [ ], ... }:

# The credential broker (Python/FastAPI). Extensible provider/transport modules;
# see docs/BROKER.md.
#
# `contribs`: out-of-tree provider packages injected into the image. Each is a
# normal Python dependency, so its dist-info lands on the app's path and the
# provider registry discovers it via the `agent_broker.providers` entry point at
# startup (see broker/core/registry.py). Defaults to none — the flake passes the
# broker-targeted subset from ./contrib.

python3Packages.buildPythonApplication {
  pname = "agent-broker";
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
    kubernetes
    pyyaml # sandbox/overlay.py parses the manifest-overlay ConfigMap payload
    pyjwt
    # AWS permissions broker
    boto3
    sqlalchemy
    asyncpg
    aiosqlite
    openfga-sdk
    scooterSchema  # generated SQLAlchemy models for the broker DB (lib/py/scooter-schema)
  ] ++ contribs;

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
    cryptography
  ];
  pythonImportsCheck = [ "broker.core.app" ];

  meta.description = "Extensible credential broker for kubenix-agent-manager";
}
