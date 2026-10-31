{ lib, python3Packages, scooter-lib, ... }:

# scooter_broker_lib: the broker extension surface (provider/transport/source
# contracts and building blocks) that a provider build-depends on instead of the
# broker app. Depends only on scooter_lib; the DB drivers stay with the app since
# engine creation is lazy.

python3Packages.buildPythonPackage {
  pname = "scooter-broker-lib";
  version = "0.0.0";
  src = lib.cleanPackageSource ./.;
  pyproject = true;

  build-system = [ python3Packages.hatchling ];

  dependencies = with python3Packages; [
    scooter-lib
    fastapi
    httpx
    sqlalchemy
    cryptography
    # A contrib declaring MCP tools imports fastmcp directly.
    fastmcp
  ];

  nativeCheckInputs = with python3Packages; [
    pytestCheckHook
    pytest-asyncio
    # sqlite_config() in tests; deployments use Postgres.
    aiosqlite
  ];
  # Every sub-package, so a broken import fails this build rather than a provider
  # quietly missing at broker startup.
  pythonImportsCheck = [
    "scooter_broker_lib.types"
    "scooter_broker_lib.registry"
    "scooter_broker_lib.autolink"
    "scooter_broker_lib.sources.static_token"
    "scooter_broker_lib.transports.http_proxy"
    "scooter_broker_lib.transports.whoami"
    "scooter_broker_lib.transports.token_vend"
    "scooter_broker_lib.transports.mcp_tools"
    "scooter_broker_lib.forge"
    "scooter_broker_lib.mcp"
    "scooter_broker_lib.links"
    "scooter_broker_lib.refs"
    "scooter_broker_lib.store"
    "scooter_broker_lib.authz"
    "scooter_broker_lib.context"
    "scooter_broker_lib.owner"
    "scooter_broker_lib.user_secrets"
    "scooter_broker_lib.sources.user_first"
    "scooter_broker_lib.ssh_keys"
    "scooter_broker_lib.user_auth"
    "scooter_broker_lib.commit_identity"
    "scooter_broker_lib.testing"
  ];

  meta.description = "The broker extension surface for Scooter providers";
}
