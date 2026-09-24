{ lib, python3Packages, scooterLib, ... }:

# scooter_broker_lib — the broker extension surface (provider/transport/source
# contracts + reusable building blocks). A broker provider — in-tree or a contrib
# — build-depends on this instead of the broker app, which breaks the app<->contrib
# build cycle. Depends only on scooter_lib.
#
# NOTE the absent pyjwt/cryptography: those were here only for the GitHub App
# credential source, which is github's implementation and now sits with github
# in broker/sources/. A shared lib pulling a crypto stack for one integration was
# the boundary being wrong out loud. See PR #567.
#
# sqlalchemy IS here, by that same test: three stores already compose `store.py`
# (aws, registry, shares) and a contrib that owns a table is the fourth. The DB
# DRIVERS stay with the app — engine creation is lazy, so asyncpg/aiosqlite are
# only needed where a connection is actually opened. See PR #622.

python3Packages.buildPythonPackage {
  pname = "scooter-broker-lib";
  version = "0.0.0";
  src = ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooterLib
    fastapi
    httpx
    sqlalchemy
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
  ];
  # Every sub-package, so a transport or source that fails to import is this
  # build's failure rather than a provider quietly missing at broker startup —
  # the whole point of making the surface a real build dependency.
  pythonImportsCheck = [
    "scooter_broker_lib.types"
    "scooter_broker_lib.registry"
    "scooter_broker_lib.autolink"
    "scooter_broker_lib.sources.static_token"
    "scooter_broker_lib.transports.http_proxy"
    "scooter_broker_lib.transports.git_credential"
    "scooter_broker_lib.transports.whoami"
    "scooter_broker_lib.transports.token_vend"
    "scooter_broker_lib.store"
    "scooter_broker_lib.authz"
    "scooter_broker_lib.context"
  ];

  meta.description = "The broker extension surface for Scooter providers";
}
