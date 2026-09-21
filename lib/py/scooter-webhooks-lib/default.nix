{ lib, python3Packages, scooterLib, scooterSchema, ... }:

# scooter_webhooks_lib — the webhooks extension surface (handler contract + the
# generic spawn/identity/store building blocks). A webhooks handler — in-tree or a
# contrib — build-depends on this instead of the webhooks app, breaking the
# app<->contrib build cycle. Depends on scooter_lib + scooter_schema.

python3Packages.buildPythonPackage {
  pname = "scooter-webhooks-lib";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooterLib
    scooterSchema
    fastapi
    httpx
    pydantic
    pydantic-settings
    sqlalchemy
    aiosqlite
    asyncpg
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  pythonImportsCheck = [
    "scooter_webhooks_lib.registry"
    "scooter_webhooks_lib.store"
    "scooter_webhooks_lib.resources"
  ];

  meta.description = "The webhooks extension surface for Scooter handlers";
}
