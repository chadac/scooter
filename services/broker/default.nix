{ lib, python3Packages, ... }:

# The credential broker (Python/FastAPI). Extensible provider/transport modules;
# see docs/BROKER.md.

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
    pyjwt
    # AWS permissions broker
    boto3
    sqlalchemy
    asyncpg
    aiosqlite
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
    cryptography
  ];
  pythonImportsCheck = [ "broker.core.app" ];

  meta.description = "Extensible credential broker for kubenix-agent-manager";
}
